# cricket-mcp

A cricket stats nerd's dream, wired directly into Claude.

**cricket-mcp** is an MCP (Model Context Protocol) server that turns 10.9 million ball-by-ball deliveries from [Cricsheet](https://cricsheet.org) into a queryable cricket brain. Think ESPNcricinfo's Statsguru, but you just *ask questions in plain English* and get answers.

21,000+ matches. Every format. Every ball. All sitting in a local DuckDB database that answers in milliseconds.

## What can it do?

Ask Claude things like:
- *"How does Kohli bat against Hazlewood in ODIs?"*
- *"Who has the best bowling average against left-handers in T20Is since 2020?"*
- *"Show me Bumrah's record against Warner in Tests"*
- *"What are the highest partnerships at the MCG?"*
- *"Break down Rohit Sharma's record against each of England's bowlers"*
- *"Which bowlers have dismissed Williamson the most in Tests?"*

## Tools (14 total)

### Player Stats
| Tool | What it does |
|------|-------------|
| `search_players` | Fuzzy name search with career summary |
| `get_player_batting_stats` | Full batting stats — avg, SR, 100s, 50s, HS, 4s, 6s, ducks |
| `get_player_bowling_stats` | Full bowling stats — avg, econ, SR, maidens, 5wi, best figures |

### Match & Team Queries
| Tool | What it does |
|------|-------------|
| `search_matches` | Find matches with filters + pagination |
| `get_head_to_head` | Team vs team W/L/D/T record |
| `get_match_scorecard` | Complete batting + bowling card for any match |

### Records & Leaderboards
| Tool | What it does |
|------|-------------|
| `get_batting_records` | Rank players by runs, avg, SR, 100s, 50s, 6s, 4s, HS |
| `get_bowling_records` | Rank players by wickets, avg, econ, SR, 5wi |

### Venue & Partnerships
| Tool | What it does |
|------|-------------|
| `get_venue_stats` | Ground stats — avg scores, bat-first win %, highest/lowest totals |
| `get_partnerships` | Highest batting partnerships |

### Batter vs Bowler Matchups
| Tool | What it does |
|------|-------------|
| `get_batter_vs_bowler` | Batter's record against a specific bowler |
| `get_bowler_vs_batter` | Bowler's record against a specific batter |
| `get_batter_vs_team_bowling` | Batter vs each bowler in an opposition team |
| `get_matchup_records` | Leaderboards — who dismisses X the most? Who scores most off Y? |

Every tool supports filters: **format** (Test/ODI/T20/IT20), **gender**, **team**, **opposition**, **venue**, **city**, **season**, **tournament**, and **date range**.

## Setup

### Prerequisites
- Node.js 18+
- Claude Desktop (or any MCP client)

### Install

```bash
git clone https://github.com/mavaali/cricket-mcp.git
cd cricket-mcp
npm install
```

### Ingest the data

This downloads all Cricsheet data (~94 MB ZIP, 21,000+ matches) and loads it into a local DuckDB database:

```bash
npm run ingest
```

Takes a few minutes. You'll see progress like:

```
Downloading from https://cricsheet.org/downloads/all_json.zip...
Download size: 93.7 MB
Extracted 21270 JSON files
Ingested 21270/21270 matches (10,895,339 deliveries)
Creating indexes...
=== Ingestion Complete ===
  Matches:    21270
  Deliveries: 10895339
  Players:    14406
```

### Connect to Claude Desktop

Add this to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "cricket": {
      "command": "npx",
      "args": ["tsx", "/path/to/cricket-mcp/src/index.ts", "serve"]
    }
  }
}
```

Replace `/path/to/cricket-mcp` with the actual path. Restart Claude Desktop.

That's it. Start asking cricket questions.

## Example Queries

### "How does Kohli fare against Hazlewood in ODIs?"

Uses `get_batter_vs_bowler` with `batter_name: "Kohli"`, `bowler_name: "Hazlewood"`, `match_type: "ODI"`.

### "Who are the top 5 run scorers in IPL history?"

Uses `get_batting_records` with `record_type: "most_runs"`, `event_name: "Indian Premier League"`, `limit: 5`.

### "India vs Australia head to head in Tests"

Uses `get_head_to_head` with `team1: "India"`, `team2: "Australia"`, `match_type: "Test"`.

### "Which bowlers trouble Williamson the most in Tests?"

Uses `get_matchup_records` with `batter_name: "Williamson"`, `record_type: "most_dismissals"`, `match_type: "Test"`.

### "Break down Rohit's record against England's bowlers in ODIs"

Uses `get_batter_vs_team_bowling` with `batter_name: "Rohit"`, `opposition: "England"`, `match_type: "ODI"`.

## How it works

1. **Data**: [Cricsheet](https://cricsheet.org) provides free, open ball-by-ball data for every international and major domestic cricket match in JSON format.
2. **Storage**: The `ingest` command downloads, parses, and loads this into a local [DuckDB](https://duckdb.org) database — a columnar analytics engine that eats aggregation queries for breakfast.
3. **Server**: The MCP server exposes 14 tools over stdio. Claude picks the right tool based on your question, passes the right filters, and returns the stats.

### Database schema

Four tables in a star schema:
- **players** — 14K players with Cricsheet registry IDs
- **matches** — 21K matches with metadata (teams, venue, outcome, tournament)
- **innings** — innings-level data (batting/bowling team, targets, declarations)
- **deliveries** — 10.9M rows, one per ball bowled (batter, bowler, runs, extras, wickets)

### Cricket logic handled correctly

- **Batting average** = runs / dismissals (not innings)
- **Balls faced** excludes wides (standard convention)
- **Bowler runs** exclude byes and legbyes
- **Legal deliveries** exclude wides AND noballs
- **Bowling wickets** only count bowling dismissals (not run outs)
- **Maidens** computed at the over level

## Data source

All data comes from [Cricsheet](https://cricsheet.org), which provides free, open cricket data. Massive thanks to them for making this possible.

## License

MIT
