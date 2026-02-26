# cricket-mcp

A cricket stats nerd's dream, wired directly into Claude.

**cricket-mcp** is an MCP (Model Context Protocol) server that turns 10.9 million ball-by-ball deliveries from [Cricsheet](https://cricsheet.org) into a queryable cricket brain. Think ESPNcricinfo's Statsguru, but you just *ask questions in plain English* and get answers.

21,000+ matches. Every format. Every ball. All sitting in a local DuckDB database that answers in milliseconds.

## What can it do?

Ask Claude things like:
- *"How does Kohli bat against Hazlewood in ODIs?"*
- *"Best death bowlers in IPL by economy"*
- *"Kohli's average while chasing in ODIs"*
- *"Who is close to 10000 Test runs?"*
- *"What would Kohli average without Hazlewood?"*
- *"Does the toss matter in T20s?"*
- *"IPL 2024 standings and top performers"*
- *"Which bowlers have the best dot ball % at the death?"*
- *"Which batters are improving this season?"*
- *"Break down Rohit Sharma's record against each of England's bowlers"*

## Tools (25 total)

### Player Stats
| Tool | What it does |
|------|-------------|
| `search_players` | Fuzzy name search with career summary |
| `get_player_stats` | Full batting or bowling stats (use `perspective` param) — avg, SR, 100s, 50s, HS, 4s, 6s, maidens, 5wi, best figures |

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
| `get_matchup` | Head-to-head stats between a specific batter and bowler (use `perspective` for sort order) |
| `get_batter_vs_team_bowling` | Batter vs each bowler in an opposition team |
| `get_matchup_records` | Leaderboards — who dismisses X the most? Who scores most off Y? |

### Phase & Situation Analysis
| Tool | What it does |
|------|-------------|
| `get_phase_stats` | Batting/bowling stats by phase — powerplay (1-6), middle (7-15), death (16-20) |
| `get_situational_stats` | Stats while chasing, setting, under pressure, or by batting position. Format-aware (Tests use 4th innings for chasing) |
| `get_toss_analysis` | Toss impact on outcomes — bat first vs chase win %, by venue/team/format |
| `get_discipline_stats` | The boring stats that win tournaments — dot ball %, wide rate, boundary % |

### Team & Tournament
| Tool | What it does |
|------|-------------|
| `get_team_form` | Recent form — last N results, win streak, avg scores, run rate |
| `get_tournament_summary` | Standings, top batters, top bowlers for any tournament/season |

### Career & Trends
| Tool | What it does |
|------|-------------|
| `get_milestone_tracker` | Players near career milestones (10000 runs, 500 wickets, etc.) |
| `get_emerging_players` | Players whose recent stats significantly outperform career baseline |
| `get_what_if` | Counterfactual — recalculate career stats excluding opponents, bowlers, venues, or tournaments |
| `get_season_stats` | Year-by-year career breakdown |
| `get_player_comparison` | Side-by-side comparison of two players |

### Fielding & Dismissals
| Tool | What it does |
|------|-------------|
| `get_fielding_stats` | Catches, stumpings, run outs per fielder |
| `get_dismissal_analysis` | Breakdown of how a player gets out (or gets batters out) |

### Innings Analysis
| Tool | What it does |
|------|-------------|
| `get_innings_progression` | Over-by-over scoring progression for a match innings |

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

### Keep data up to date

Cricsheet publishes new matches daily. Instead of re-ingesting everything, pull just the recent matches:

```bash
npm run update          # last 7 days (default)
npm run update -- --days 2   # last 2 days
npm run update -- --days 30  # last 30 days
```

Downloads `recently_played_N_json.zip` from Cricsheet, skips matches already in the DB, inserts only new ones. Takes seconds.

For a full rebuild (e.g., to pick up Cricsheet corrections to historical data):

```bash
npm run ingest -- --force
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

Uses `get_matchup` with `batter_name: "Kohli"`, `bowler_name: "Hazlewood"`, `match_type: "ODI"`.

### "Best death bowlers in IPL"

Uses `get_phase_stats` with `phase: "death"`, `perspective: "bowling"`, `event_name: "Indian Premier League"`, `sort_by: "economy"`.

### "Kohli's record while chasing in ODIs"

Uses `get_situational_stats` with `situation: "chasing"`, `player_name: "Kohli"`, `match_type: "ODI"`.

### "Who is close to 10000 ODI runs?"

Uses `get_milestone_tracker` with `milestone_type: "runs"`, `threshold: 10000`, `match_type: "ODI"`.

### "What would Kohli average without Hazlewood?"

Uses `get_what_if` with `player_name: "Kohli"`, `perspective: "batting"`, `exclude_bowler: "Hazlewood"`, `match_type: "ODI"`.

### "IPL 2024 standings and top performers"

Uses `get_tournament_summary` with `event_name: "Indian Premier League"`, `season: "2024"`.

### "Does the toss matter in T20s?"

Uses `get_toss_analysis` with `match_type: "T20"`.

### "India vs Australia head to head in Tests"

Uses `get_head_to_head` with `team1: "India"`, `team2: "Australia"`, `match_type: "Test"`.

### "Which batters are improving in T20s this season?"

Uses `get_emerging_players` with `perspective: "batting"`, `match_type: "T20"`.

### "Who has the best dot ball % at the death in IPL?"

Uses `get_discipline_stats` with `perspective: "bowling"`, `phase: "death"`, `event_name: "Indian Premier League"`, `sort_by: "dot_ball_pct"`.

## How it works

1. **Data**: [Cricsheet](https://cricsheet.org) provides free, open ball-by-ball data for every international and major domestic cricket match in JSON format.
2. **Storage**: The `ingest` command downloads, parses, and loads this into a local [DuckDB](https://duckdb.org) database — a columnar analytics engine that eats aggregation queries for breakfast.
3. **Server**: The MCP server exposes 25 tools over stdio. Claude picks the right tool based on your question, passes the right filters, and returns the stats.

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
- **Test innings** — chasing means 4th innings, setting means 1st innings

## Changelog

### Unreleased
- Consolidated similar tools (28 → 25): `get_matchup` replaces separate batter-vs-bowler / bowler-vs-batter tools, `get_player_stats` replaces separate batting / bowling stats tools
- Added 5 new tools: fielding stats, dismissal analysis, season stats, player comparison, innings progression
- Extracted shared constants (`BOWLING_WICKET_KINDS`, `PHASE_OVERS`) to reduce duplication

### v0.1.0
- 23 tools covering player stats, matchups, records, phase/situational analysis, team form, tournaments, milestones, emerging players, what-if scenarios
- Incremental data updates (`npm run update`) using Cricsheet's recent match feeds
- Full ingest pipeline: download → parse → load into DuckDB
- 19 evals

## Data source

All data comes from [Cricsheet](https://cricsheet.org), which provides free, open cricket data. Massive thanks to them for making this possible.

## License

MIT
