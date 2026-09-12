export default async function handler(req, res) {
  const apiKey = process.env.PARLAY_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "PARLAY_API_KEY is not configured."
    });
  }

  const markets = [
    "player_pass_yds",
    "player_pass_tds",
    "player_pass_completions",
    "player_rush_yds",
    "player_rush_attempts",
    "player_receptions",
    "player_reception_yds",
    "player_rush_reception_yds",
    "player_anytime_td"
  ].join(",");

  try {
    const url = new URL(
      "https://parlay-api.com/v1/sports/americanfootball_nfl/props"
    );

    const response = await fetch(url, {
      headers: {
        "X-API-Key": apiKey
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.message || "Unable to load NFL props.",
        detail: data
      });
    }

    const props = [];

    const rows = Array.isArray(data) ? data : data.props || data.data || data.results || [];

for (const row of rows) {
      const playerName = row.player_name || row.player || "";
if (!playerName || row.line === undefined) continue;

      const base = {
        eventId: row.event_id || null,
        commenceTime: row.commence_time || null,
        homeTeam: row.home_team || "",
        awayTeam: row.away_team || "",
        bookmaker: row.bookmaker || "unknown",
        bookmakerTitle: row.bookmaker_title || "Unknown",
        market: row.market_key || "",
        player: playerName,
        point: Number(row.line),
        lastUpdate: row.last_update || null
      };

      if (row.over_price !== undefined && row.over_price !== null) {
        props.push({
          ...base,
          side: "Over",
          price: Number(row.over_price)
        });
      }

      if (row.under_price !== undefined && row.under_price !== null) {
        props.push({
          ...base,
          side: "Under",
          price: Number(row.under_price)
        });
      }
    }

    return res.status(200).json({
      sport: "NFL",
      source: "ParlayAPI",
      fetchedAt: new Date().toISOString(),
      count: props.length,
      props
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "EdgeHunt could not load live NFL props.",
      detail: error.message
    });
  }
}
