export default async function handler(req, res) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ODDS_API_KEY is not configured." });

  const MARKET_MAP = {
    player_pass_yds: "pass_yds",
    player_pass_tds: "pass_tds",
    player_rush_yds: "rush_yds",
    player_receptions: "receptions",
    player_reception_yds: "reception_yds",
    player_rush_reception_yds: "rush_reception_yds",
    player_pass_completions: "pass_completions",
    player_rush_attempts: "rush_attempts",
    player_reception_tds: "reception_tds",
    player_rush_tds: "rush_tds"
  };

  const STAT_FIELDS = {
    pass_yds: ["passing_yards", "pass_yd"],
    pass_tds: ["passing_tds", "pass_td"],
    rush_yds: ["rushing_yards", "rush_yd"],
    receptions: ["receptions", "rec"],
    reception_yds: ["receiving_yards", "rec_yd"],
    rush_reception_yds: ["rush_yd", "rushing_yards", "rec_yd", "receiving_yards"],
    pass_completions: ["completions", "pass_cmp"],
    rush_attempts: ["carries", "rush_att"],
    reception_tds: ["receiving_tds", "rec_td"],
    rush_tds: ["rushing_tds", "rush_td"]
  };

  const markets = Object.keys(MARKET_MAP).join(",");

  const norm = (s) => String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

  const median = (arr) => {
    const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };

  const mean = (arr) => {
    const a = arr.filter(Number.isFinite);
    return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  };

  const pickField = (row, names) => {
    for (const name of names) {
      if (row && row[name] !== undefined && row[name] !== null && row[name] !== "") {
        const n = Number(row[name]);
        if (Number.isFinite(n)) return n;
      }
    }
    return null;
  };

  const statValue = (row, market) => {
    if (!row) return null;
    if (market === "rush_reception_yds") {
      const rush = pickField(row, ["rush_yd", "rushing_yards"]);
      const rec = pickField(row, ["rec_yd", "receiving_yards"]);
      return Number.isFinite(rush) || Number.isFinite(rec)
        ? (rush || 0) + (rec || 0)
        : null;
    }
    return pickField(row, STAT_FIELDS[market] || []);
  };

  async function getJson(url) {
    const r = await fetch(url, {
      headers: { "User-Agent": "EdgeHunt/1.0" }
    });
    const data = await r.json();
    if (!r.ok) {
      throw new Error(data?.message || `Request failed: ${r.status}`);
    }
    return data;
  }

  async function getCsvRows(url) {
    const r = await fetch(url, {
      headers: { "User-Agent": "EdgeHunt/1.0" }
    });

    if (!r.ok) return [];

    const text = await r.text();
    const lines = text.split(/\r?\n/).filter(Boolean);

    if (lines.length < 2) return [];

    const parseLine = (line) => {
      const out = [];
      let cur = "";
      let quote = false;

      for (let i = 0; i < line.length; i++) {
        const c = line[i];

        if (c === '"') {
          if (quote && line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            quote = !quote;
          }
        } else if (c === "," && !quote) {
          out.push(cur);
          cur = "";
        } else {
          cur += c;
        }
      }

      out.push(cur);
      return out;
    };

    const headers = parseLine(lines[0]).map(h =>
      h.replace(/^"|"$/g, "")
    );

    return lines.slice(1).map(line => {
      const vals = parseLine(line);
      const row = {};
      headers.forEach((h, i) => {
        row[h] = vals[i] ?? "";
      });
      return row;
    });
  }

  try {
    const eventsUrl = new URL(
      "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/events"
    );

    eventsUrl.searchParams.set("apiKey", apiKey);
    eventsUrl.searchParams.set("dateFormat", "iso");

    const events = await getJson(eventsUrl);

    const propResults = [];

    for (const event of events.slice(0, 12)) {
      const oddsUrl = new URL(
        `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/events/${event.id}/odds`
      );

      oddsUrl.searchParams.set("apiKey", apiKey);
      oddsUrl.searchParams.set("regions", "us,us_dfs");
      oddsUrl.searchParams.set("markets", markets);
      oddsUrl.searchParams.set("oddsFormat", "american");

      const data = await getJson(oddsUrl);

      for (const bookmaker of data.bookmakers || []) {
        for (const market of bookmaker.markets || []) {
          for (const outcome of market.outcomes || []) {
            if (!outcome.description || outcome.point === undefined) continue;

            propResults.push({
              eventId: event.id,
              commenceTime: event.commence_time,
              homeTeam: event.home_team,
              awayTeam: event.away_team,
              bookmaker: bookmaker.key,
              bookmakerTitle: bookmaker.title,
              market: market.key,
              player: outcome.description,
              side: outcome.name,
              point: Number(outcome.point),
              price: Number(outcome.price),
              lastUpdate:
                bookmaker.last_update ||
                market.last_update ||
                null
            });
          }
        }
      }
    }

    if (!propResults.length) {
      return res.status(200).json({
        sport: "NFL",
        fetchedAt: new Date().toISOString(),
        count: 0,
        props: [],
        modelVersion: "edgehunt-v1-market-plus-history"
      });
    }

    const [currentRows, priorRows] = await Promise.all([
      getCsvRows(
        "https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_reg_2026.csv"
      ),
      getCsvRows(
        "https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_reg_2025.csv"
      )
    ]);

    const historyRows = [...priorRows, ...currentRows];

    const byPlayer = new Map();

    for (const row of historyRows) {
      const name =
        row.player_display_name ||
        row.player_name ||
        row.name;

      if (!name) continue;

      const key = norm(name);

      if (!byPlayer.has(key)) {
        byPlayer.set(key, []);
      }

      byPlayer.get(key).push(row);
    }

    const groups = new Map();

    for (const p of propResults) {
      const key = [
        p.eventId,
        p.market,
        norm(p.player),
        p.point
      ].join("|");

      if (!groups.has(key)) {
        groups.set(key, []);
      }

      groups.get(key).push(p);
    }

    const output = [];

    for (const [, rows] of groups) {
      const sample = rows[0];
      const market = MARKET_MAP[sample.market];

      const books = rows.map(r => ({
        book: r.bookmakerTitle,
        bookKey: r.bookmaker,
        side: r.side,
        point: r.point,
        price: r.price,
        lastUpdate: r.lastUpdate
      }));

      const points = rows
        .map(r => r.point)
        .filter(Number.isFinite);

      const consensusLine = median(points);

      const history = (byPlayer.get(norm(sample.player)) || [])
        .map(row => ({
          row,
          value: statValue(row, market),
          week: Number(
            row.week ||
            row.game_week ||
            row.game_week_num ||
            0
          ),
          season: Number(row.season || 0)
        }))
        .filter(x => Number.isFinite(x.value))
        .sort(
          (a, b) =>
            (b.season - a.season) ||
            (b.week - a.week)
        );

      const weekly = history.filter(x => x.week > 0);
      const values = weekly.length
        ? weekly.map(x => x.value)
        : [];

      const l5 = values.slice(0, 5);
      const l10 = values.slice(0, 10);
      const l20 = values.slice(0, 20);

      const avg5 = mean(l5);
      const avg10 = mean(l10);
      const avg20 = mean(l20);

      let projection = consensusLine;

      if (avg5 !== null) {
        const components = [];

        if (avg5 !== null) components.push([avg5, 0.50]);
        if (avg10 !== null) components.push([avg10, 0.30]);
        if (avg20 !== null) components.push([avg20, 0.20]);

        const weight = components.reduce(
          (s, [, w]) => s + w,
          0
        );

        projection =
          components.reduce(
            (s, [v, w]) => s + v * w,
            0
          ) / weight;
      }

      const hitRate = (n, side) => {
        if (!n.length || consensusLine === null) {
          return null;
        }

        const hits = n.filter(v =>
          side === "Over"
            ? v > consensusLine
            : v < consensusLine
        ).length;

        return Math.round(
          (hits / n.length) * 100
        );
      };

      const overRate = hitRate(l10, "Over");
      const underRate = hitRate(l10, "Under");

      const overEdge =
        projection !== null &&
        consensusLine !== null
          ? ((projection - consensusLine) /
              Math.max(Math.abs(consensusLine), 1)) *
            100
          : 0;

      const underEdge = -overEdge;

      const bestOver =
        books
          .filter(b => b.side === "Over")
          .sort(
            (a, b) =>
              b.point - a.point ||
              b.price - a.price
          )[0] || null;

      const bestUnder =
        books
          .filter(b => b.side === "Under")
          .sort(
            (a, b) =>
              a.point - b.point ||
              b.price - a.price
          )[0] || null;

      const selectedSide =
        overEdge >= underEdge
          ? "Over"
          : "Under";

      const selectedEdge = Math.abs(
        selectedSide === "Over"
          ? overEdge
          : underEdge
      );

      const selectedHit =
        selectedSide === "Over"
          ? overRate
          : underRate;

      let confidence = 50;

      if (selectedHit !== null) {
        confidence +=
          Math.abs(selectedHit - 50) * 0.45;
      }

      confidence += Math.min(
        selectedEdge * 0.7,
        15
      );

      confidence += Math.min(
        books.length * 1.5,
        8
      );

      if (weekly.length < 5) {
        confidence -= 8;
      }

      confidence = Math.max(
        50,
        Math.min(94, Math.round(confidence))
      );

      output.push({
        eventId: sample.eventId,
        commenceTime: sample.commenceTime,
        matchup:
          `${sample.awayTeam} @ ${sample.homeTeam}`,
        player: sample.player,
        market: sample.market,
        line: consensusLine,
        projection: Number.isFinite(projection)
          ? Number(projection.toFixed(2))
          : null,
        edgePct: Number(
          selectedEdge.toFixed(1)
        ),
        edgeSide: selectedSide,
        confidence,
        l5: l5.length
          ? `${Math.round(
              (l5.filter(v =>
                selectedSide === "Over"
                  ? v > consensusLine
                  : v < consensusLine
              ).length /
                l5.length) *
                100
            )}%`
          : null,
        l10:
          selectedHit !== null
            ? `${selectedHit}%`
            : null,
        l20: l20.length
          ? `${Math.round(
              (l20.filter(v =>
                selectedSide === "Over"
                  ? v > consensusLine
                  : v < consensusLine
              ).length /
                l20.length) *
                100
            )}%`
          : null,
        historyGames: values.length,
        historyAvailable:
          weekly.length > 0,
        bestOver,
        bestUnder,
        books
      });
    }

    output.sort(
      (a, b) =>
        b.confidence - a.confidence ||
        b.edgePct - a.edgePct
    );

    return res.status(200).json({
      sport: "NFL",
      fetchedAt: new Date().toISOString(),
      count: output.length,
      modelVersion:
        "edgehunt-v1-market-plus-history",
      dataSource:
        "The Odds API + nflverse",
      props: output
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "EdgeHunt model could not load.",
      detail: error?.message || String(error)
    });
  }
}
