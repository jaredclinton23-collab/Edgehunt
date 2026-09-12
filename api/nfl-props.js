export default async function handler(req, res) {
  const apiKey = process.env.ODDS_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: "ODDS_API_KEY is not configured." });
  }

  const markets = [
    "player_pass_yds",
    "player_pass_tds",
    "player_rush_yds",
    "player_receptions",
    "player_reception_yds",
    "player_rush_reception_yds",
    "player_pass_completions",
    "player_rush_attempts",
    "player_reception_tds",
    "player_rush_tds"
  ].join(",");

  try {
    const eventsUrl = new URL(
      "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/events"
    );

    eventsUrl.searchParams.set("apiKey", apiKey);
    eventsUrl.searchParams.set("dateFormat", "iso");

    const eventsResponse = await fetch(eventsUrl);
    const events = await eventsResponse.json();

    if (!eventsResponse.ok) {
      return res.status(eventsResponse.status).json({
        error: events?.message || "Unable to load NFL events."
      });
    }

    const results = [];

    for (const event of events.slice(0, 12)) {
      const url = new URL(
        `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/events/${event.id}/odds`
      );

      url.searchParams.set("apiKey", apiKey);
      url.searchParams.set("regions", "us,us_dfs");
      url.searchParams.set("markets", markets);
      url.searchParams.set("oddsFormat", "american");

      const response = await fetch(url);
      const data = await response.json();

      if (!response.ok) continue;

      for (const bookmaker of data.bookmakers || []) {
        for (const market of bookmaker.markets || []) {
          for (const outcome of market.outcomes || []) {
            if (!outcome.name || outcome.point === undefined) continue;

            results.push({
              eventId: event.id,
              commenceTime: event.commence_time,
              homeTeam: event.home_team,
              awayTeam: event.away_team,
              bookmaker: bookmaker.key,
              bookmakerTitle: bookmaker.title,
              market: market.key,
              player: outcome.description || outcome.name,
              side: outcome.name,
              point: outcome.point,
              price: outcome.price,
              lastUpdate:
                bookmaker.last_update ||
                market.last_update ||
                null
            });
          }
        }
      }
    }

    return res.status(200).json({
      sport: "NFL",
      fetchedAt: new Date().toISOString(),
      count: results.length,
      props: results
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "EdgeHunt could not load live NFL props."
    });
  }
}
