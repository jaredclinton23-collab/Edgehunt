export default async function handler(req, res) {
  try {
    const host = req.headers.host;
    const protocol =
      req.headers["x-forwarded-proto"] || "https";

    const base = `${protocol}://${host}`;

    // Get the sportsbook props from our existing endpoint.
    // This does NOT create another Odds API implementation.
    const oddsResponse = await fetch(
      `${base}/api/nfl-props`,
      { cache: "no-store" }
    );

    const oddsData = await oddsResponse.json();

    if (!oddsResponse.ok) {
      return res.status(oddsResponse.status).json({
        error: "Unable to load live NFL props.",
        detail: oddsData?.error || "Unknown error"
      });
    }

    if (!oddsData.props || !oddsData.props.length) {
      return res.status(200).json({
        sport: "NFL",
        modelVersion: "EdgeHunt v1",
        count: 0,
        props: [],
        message: "No live NFL props are currently available."
      });
    }

    // Get historical player statistics.
    const statsResponse = await fetch(
      `${base}/api/player-stats`,
      { cache: "no-store" }
    );

    const statsData = await statsResponse.json();

    if (!statsResponse.ok) {
      return res.status(500).json({
        error: "Unable to load NFL player statistics.",
        detail: statsData?.error || "Unknown error"
      });
    }

    const stats = statsData.players || [];

    function normalize(name) {
      return String(name || "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
    }

    function number(value) {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }

    function median(values) {
      const a = values
        .filter(Number.isFinite)
        .sort((x, y) => x - y);

      if (!a.length) return null;

      const middle = Math.floor(a.length / 2);

      if (a.length % 2) {
        return a[middle];
      }

      return (a[middle - 1] + a[middle]) / 2;
    }

    function average(values) {
      const a = values.filter(Number.isFinite);

      if (!a.length) return null;

      return (
        a.reduce((sum, value) => sum + value, 0) /
        a.length
      );
    }

    function statValue(row, market) {
      switch (market) {
        case "player_pass_yds":
          return number(row.passing_yards);

        case "player_pass_tds":
          return number(row.passing_tds);

        case "player_pass_completions":
          return number(row.completions);

        case "player_rush_yds":
          return number(row.rushing_yards);

        case "player_rush_attempts":
          return number(row.rushing_attempts);

        case "player_rush_tds":
          return number(row.rushing_tds);

        case "player_receptions":
          return number(row.receptions);

        case "player_reception_yds":
          return number(row.receiving_yards);

        case "player_reception_tds":
          return number(row.receiving_tds);

        case "player_rush_reception_yds":
          return (
            number(row.rushing_yards) +
            number(row.receiving_yards)
          );

        default:
          return null;
      }
    }

    // Group historical stats by player.
    const playerHistory = new Map();

    for (const row of stats) {
      const key = normalize(row.player_name);
      if (Number(row.season) < 2025) continue;

      if (!key) continue;

      if (!playerHistory.has(key)) {
        playerHistory.set(key, []);
      }

      playerHistory.get(key).push(row);
    }

    // Sort each player's games newest first.
    for (const rows of playerHistory.values()) {
      rows.sort((a, b) => {
        const seasonA = number(a.season);
        const seasonB = number(b.season);

        if (seasonA !== seasonB) {
          return seasonB - seasonA;
        }

        return (
          number(b.week) -
          number(a.week)
        );
      });
    }

    // Group sportsbook lines by player/market/event.
    const groups = new Map();

    for (const prop of oddsData.props) {
      const key = [
        prop.eventId,
        normalize(prop.player),
        prop.market
      ].join("|");

      if (!groups.has(key)) {
        groups.set(key, []);
      }

      groups.get(key).push(prop);
    }

    const results = [];

    for (const rows of groups.values()) {
      const sample = rows[0];

      const history =
        playerHistory.get(
          normalize(sample.player)
        ) || [];

      const values = history
        .map(row =>
          statValue(row, sample.market)
        )
        .filter(value => Number.isFinite(value));
      const historyGames = history
  .map(row => ({
    season: Number(row.season),
    week: Number(row.week),
    team: row.team || null,
    value: statValue(row, sample.market)
  }))
  .filter(game => Number.isFinite(game.value));

      if (!values.length) {
        continue;
      }

      const l5 = values.slice(0, 5);
      const l10 = values.slice(0, 10);
      const l20 = values.slice(0, 20);

      const avg5 = average(l5);
      const avg10 = average(l10);
      const avg20 = average(l20);

      // Weighted projection.
      let projection = null;

      if (avg5 !== null) {
        projection =
          avg5 * 0.50 +
          (avg10 ?? avg5) * 0.30 +
          (avg20 ?? avg10 ?? avg5) * 0.20;
      }

      // Get available sportsbook lines.
      const points = rows
        .map(row => Number(row.point))
        .filter(Number.isFinite);

      const consensusLine = median(points);

      if (consensusLine === null || projection === null) {
        continue;
      }

      // Determine which side the model prefers.
      const side =
        projection > consensusLine
          ? "Over"
          : "Under";

      const difference =
        Math.abs(
          projection - consensusLine
        );

      const edgePct =
        Math.abs(
          (projection - consensusLine) /
          Math.max(Math.abs(consensusLine), 1)
        ) * 100;

      // Historical hit rates.
      function hitRate(sampleValues) {
        if (!sampleValues.length) return null;

        const hits =
          sampleValues.filter(value =>
            side === "Over"
              ? value > consensusLine
              : value < consensusLine
          ).length;

        return Math.round(
          (hits / sampleValues.length) * 100
        );
      }

      const l5Hit = hitRate(l5);
      const l10Hit = hitRate(l10);
      const l20Hit = hitRate(l20);

      // Find the best available sportsbook line.
      const books = {};

      for (const row of rows) {
        if (!books[row.bookmaker]) {
          books[row.bookmaker] = {
            title: row.bookmakerTitle,
            over: null,
            under: null
          };
        }

        if (row.side === "Over") {
          books[row.bookmaker].over = row;
        }

        if (row.side === "Under") {
          books[row.bookmaker].under = row;
        }
      }

      const bookList = Object.values(books);

      let bestBook = null;

      if (side === "Over") {
        const available =
          bookList
            .filter(book => book.over)
            .sort(
              (a, b) =>
                Number(b.over.point) -
                Number(a.over.point)
            );

        if (available.length) {
          bestBook = {
            book: available[0].title,
            line: Number(
              available[0].over.point
            ),
            price: Number(
              available[0].over.price
            )
          };
        }
      } else {
        const available =
          bookList
            .filter(book => book.under)
            .sort(
              (a, b) =>
                Number(a.under.point) -
                Number(b.under.point)
            );

        if (available.length) {
          bestBook = {
            book: available[0].title,
            line: Number(
              available[0].under.point
            ),
            price: Number(
              available[0].under.price
            )
          };
        }
      }

      // Build confidence score.
      let confidence = 50;

      if (l10Hit !== null) {
        confidence +=
          Math.abs(l10Hit - 50) * 0.45;
      }

      confidence +=
        Math.min(edgePct * 0.7, 15);

      confidence +=
        Math.min(bookList.length * 2, 8);

      if (values.length < 5) {
        confidence -= 10;
      }

      confidence = Math.max(
        50,
        Math.min(
          95,
          Math.round(confidence)
        )
      );

      // EdgeHunt score.
      let edgeScore =
        confidence +
        Math.min(edgePct * 0.35, 10);

      if (l5Hit !== null) {
        edgeScore +=
          Math.max(0, l5Hit - 50) * 0.08;
      }

      edgeScore = Math.max(
        50,
        Math.min(
          99,
          Math.round(edgeScore)
        )
      );

      results.push({
        eventId: sample.eventId,

        commenceTime:
          sample.commenceTime,

        matchup:
          `${sample.awayTeam} @ ${sample.homeTeam}`,

        player: sample.player,

        market: sample.market,

        side,

        line: consensusLine,

        projection:
          Number(projection.toFixed(2)),

        difference:
          Number(difference.toFixed(2)),

        edgePct:
          Number(edgePct.toFixed(1)),

        edgeScore,

        confidence,

        l5: {
          games: l5.length,
          hitRate: l5Hit,
          average:
            avg5 === null
              ? null
              : Number(avg5.toFixed(2))
        },

        l10: {
          games: l10.length,
          hitRate: l10Hit,
          average:
            avg10 === null
              ? null
              : Number(avg10.toFixed(2))
        },

        l20: {
          games: l20.length,
          hitRate: l20Hit,
          average:
            avg20 === null
              ? null
              : Number(avg20.toFixed(2))
        },

        historyGames:
          historyGames,

        books: bookList.map(book => ({
          book: book.title,

          over: book.over
            ? {
                line: Number(book.over.point),
                price: Number(book.over.price)
              }
            : null,

          under: book.under
            ? {
                line: Number(book.under.point),
                price: Number(book.under.price)
              }
            : null
        })),

        bestBook
      });
    }

    results.sort(
      (a, b) =>
        b.edgeScore -
        a.edgeScore
    );

    return res.status(200).json({
      sport: "NFL",

      modelVersion:
        "EdgeHunt v1",

      dataSources: [
        "The Odds API",
        "nflverse"
      ],

      generatedAt:
        new Date().toISOString(),

      count: results.length,

      props: results
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error:
        "EdgeHunt model could not calculate props.",

      detail:
        error?.message ||
        String(error)
    });
  }
}
