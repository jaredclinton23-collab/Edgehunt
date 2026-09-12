let cache = null;
let cacheTime = 0;

export default async function handler(req, res) {
  try {
    // Keep the data cached for 15 minutes so we don't repeatedly
    // download the NFL dataset.
    if (cache && Date.now() - cacheTime < 15 * 60 * 1000) {
      return res.status(200).json(cache);
    }

    const url =
      "https://github.com/nflverse/nflverse-data/releases/download/player_stats/player_stats.csv.gz";

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `nflverse request failed: ${response.status}`
      );
    }

    const compressed = await response.arrayBuffer();

    // Decompress the .gz file.
    const stream = new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));

    const text = await new Response(stream).text();

    const lines = text
      .split(/\r?\n/)
      .filter(Boolean);

    if (lines.length < 2) {
      throw new Error("No player statistics were returned.");
    }

    function parseCSVLine(line) {
      const result = [];
      let current = "";
      let quoted = false;

      for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"') {
          if (quoted && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            quoted = !quoted;
          }
        } else if (char === "," && !quoted) {
          result.push(current);
          current = "";
        } else {
          current += char;
        }
      }

      result.push(current);
      return result;
    }

    const headers = parseCSVLine(lines[0]);

    const players = lines.slice(1).map(line => {
      const values = parseCSVLine(line);
      const row = {};

      headers.forEach((header, index) => {
        row[header] = values[index] ?? "";
      });

      return row;
    });

    const useful = players.map(row => ({
      player_id:
        row.player_id ||
        row.gsis_id ||
        null,

      player_name:
        row.player_display_name ||
        row.player_name ||
        null,

      position:
        row.position ||
        null,

      team:
        row.recent_team ||
        row.team ||
        null,

      season:
        Number(row.season) || null,

      week:
        Number(row.week) || null,

      games:
        Number(row.games) || null,

      passing_yards:
        Number(row.passing_yards) || 0,

      passing_tds:
        Number(row.passing_tds) || 0,

      passing_attempts:
        Number(row.attempts) || 0,

      completions:
        Number(row.completions) || 0,

      rushing_yards:
        Number(row.rushing_yards) || 0,

      rushing_tds:
        Number(row.rushing_tds) || 0,

      rushing_attempts:
        Number(row.carries) || 0,

      receptions:
        Number(row.receptions) || 0,

      receiving_yards:
        Number(row.receiving_yards) || 0,

      receiving_tds:
        Number(row.receiving_tds) || 0,

      targets:
        Number(row.targets) || 0
    }));

    cache = {
      source: "nflverse",
      updatedAt: new Date().toISOString(),
      count: useful.length,
      players: useful
    };

    cacheTime = Date.now();

    return res.status(200).json(cache);

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "EdgeHunt could not load NFL player statistics.",
      detail: error.message
    });
  }
}
