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
- *"Who had the biggest impact in the T20 World Cup 2024 final?"*
- *"Bumrah's last 10 T20 innings — is he in form?"*

## Tools (28 total)

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
| `get_matchup` | Head-to-head stats (both names), batter vs team bowling (batter + opposition), or matchup leaderboards (one name + record_type) |
| `get_style_matchup` | Batter vs bowling styles (pace/spin, left-arm/right-arm) or bowler vs batting hand |

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

### Impact Scoring
| Tool | What it does |
|------|-------------|
| `get_match_impact` | Context-weighted impact scores for every player in a match — batting, bowling, fielding combined |
| `get_career_impact` | Aggregated impact scores across a player's career or filtered matches |
| `get_player_form` | Last N innings with individual scores, strike rates, and form summary |

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

### Enrich player metadata

Cricsheet data doesn't include player attributes like batting hand or bowling style. The repo includes `data/player_meta.csv` (from the [cricketdata](https://github.com/ropenscilabs/cricketdata) R package, 16K players) which adds these attributes. Run this after your first ingest:

```bash
npm run enrich -- --csv data/player_meta.csv
```

This enables the `get_style_matchup` tool — e.g., *"How does Kohli bat against left-arm pace?"* or *"Bumrah's record against left-handers"*.

> **Note:** The MCP server must not be running when you enrich (DuckDB allows only one write connection). Quit Claude Desktop first, run the command, then reopen.

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

### Connect to VS Code (Copilot)

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "cricket-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "tsx", "/path/to/cricket-mcp/src/index.ts", "serve"]
    }
  }
}
```

The `-y` flag prevents npx from prompting for install confirmation, which would hang the MCP stdio transport.

### OneLake backend (Microsoft Fabric)

Instead of a local DuckDB file, cricket-mcp can read Delta tables directly from a Fabric lakehouse via OneLake. All 26 tools work unchanged — DuckDB's `delta` and `azure` extensions handle the reads.

**Prerequisites:**
- Azure CLI installed and logged in (`az login`)
- A Fabric lakehouse with the cricket tables (players, matches, innings, deliveries) as Delta tables
- Workspace ID and Lakehouse ID from the Fabric portal

**CLI usage:**

```bash
npx tsx src/index.ts serve --backend onelake \
  --workspace-id <WORKSPACE_ID> \
  --lakehouse-id <LAKEHOUSE_ID>
```

**VS Code mcp.json:**

```json
{
  "servers": {
    "cricket-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y", "tsx", "/path/to/cricket-mcp/src/index.ts",
        "serve", "--backend", "onelake",
        "--workspace-id", "${env:FABRIC_WORKSPACE_ID}",
        "--lakehouse-id", "${env:FABRIC_LAKEHOUSE_ID}"
      ],
      "env": {
        "FABRIC_WORKSPACE_ID": "<your-workspace-id>",
        "FABRIC_LAKEHOUSE_ID": "<your-lakehouse-id>"
      }
    }
  }
}
```

> **Note:** The `env` block is important — VS Code may not inherit shell environment variables (e.g., from `.zshrc`) if launched from the Dock or Spotlight. Setting them explicitly in the config ensures they're always available.

**How it works:** On startup, cricket-mcp creates an in-memory DuckDB instance, loads the `delta` and `azure` extensions, authenticates via Azure CLI, and creates views over each Delta table in OneLake. The MCP transport connects immediately while the database initializes in the background — the first tool call waits for initialization to complete, subsequent calls resolve instantly.

See [cricket-data-factory](https://github.com/mavaali/cricket-data-factory) for the full pipeline that loads Cricsheet data into a Fabric lakehouse.

### Remote hosting (HTTP transport)

By default, cricket-mcp uses stdio transport for local MCP clients (Claude Desktop, VS Code). To host the server remotely, use the HTTP transport:

```bash
npx tsx src/index.ts serve --transport http --port 3000
```

This starts an HTTP server on the specified port with a single `/mcp` endpoint. MCP clients connect by sending JSON-RPC requests to `http://your-server:3000/mcp`. The server supports multiple concurrent client sessions, each with its own session ID.

CORS headers are included on all responses, so browser-based MCP clients work out of the box.

### Docker

Build a self-contained Docker image that ingests all Cricsheet data and serves over HTTP:

```bash
docker build -t cricket-mcp .
docker run -p 3000:3000 cricket-mcp
```

The build takes a few minutes (downloads ~94 MB of Cricsheet data, ingests 21K+ matches, enriches player metadata). The resulting image is ~600 MB.

To deploy on any cloud provider, push the image to a container registry and run it on a VM, managed container service (Cloud Run, ECS, Azure Container Apps), or Kubernetes.

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

### "How does Kohli bat against left-arm pace?"

Uses `get_style_matchup` with `player_name: "Kohli"`, `perspective: "batting"`, `grouping: "arm"`.

### "Bumrah's record against left-handers"

Uses `get_style_matchup` with `player_name: "Bumrah"`, `perspective: "bowling"`.

### "Who had the biggest impact in the T20 World Cup 2024 final?"

Uses `get_match_impact` with `match_id: "1415755"` (find the ID via `search_matches` first).

Returns phase-relative impact scores: Bumrah's 2/18 in 4 overs scores an economy_value of **17.63** because his 4.5 RPO in death overs was extraordinary against a match death-over average of 10+. Axar Patel tops the chart (136.82) with a 47(31) plus a death-over wicket.

### "Which batters are improving in T20s this season?"

Uses `get_emerging_players` with `perspective: "batting"`, `match_type: "T20"`.

### "Who has the best dot ball % at the death in IPL?"

Uses `get_discipline_stats` with `perspective: "bowling"`, `phase: "death"`, `event_name: "Indian Premier League"`, `sort_by: "dot_ball_pct"`.

## How it works

1. **Data**: [Cricsheet](https://cricsheet.org) provides free, open ball-by-ball data for every international and major domestic cricket match in JSON format.
2. **Storage**: The `ingest` command downloads, parses, and loads this into a local [DuckDB](https://duckdb.org) database — a columnar analytics engine that eats aggregation queries for breakfast.
3. **Server**: The MCP server exposes 28 tools over stdio. Claude picks the right tool based on your question, passes the right filters, and returns the stats.

### Database schema

Four tables in a star schema:
- **players** — 14K players with Cricsheet registry IDs (optionally enriched with batting style, bowling style, playing role, country)
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

## Data Coverage & Limitations

All statistics are derived from [Cricsheet](https://cricsheet.org) ball-by-ball data. Cricsheet is an open-source project that provides detailed delivery-level records — but it doesn't cover the full history of cricket. Think of it as a high-resolution camera that was installed partway through the movie.

### Coverage windows

| Format | Earliest match in dataset | Notes |
|--------|--------------------------|-------|
| **Tests** | ~Dec 2001 | Covers the 2001/02 season onwards. Players whose careers were primarily pre-2002 (Bradman, Gavaskar, Border, etc.) will be absent or severely underrepresented. |
| **ODIs** | ~Jun 2002 | Includes the 2003 World Cup onwards. The first ~30 years of ODI cricket (1971-2002) are not covered — no Kapil Dev 175, no 1996 World Cup. |
| **T20Is** | ~Feb 2005 | Near-complete from the format's inception (first T20I was Feb 2005). |
| **T20 (domestic)** | ~Apr 2008 | IPL Season 1 onwards. Also includes BBL, CPL, PSL, SA20, and other domestic T20 leagues where Cricsheet has coverage. |

Data is updated regularly and includes matches through early 2026 at time of writing.

### What this means in practice

- **Career stats for active or recent players** (Smith, Kohli, Root, Bumrah, etc.) are comprehensive and reliable.
- **Career stats for players who debuted before ~2002** will only reflect the tail end of their careers. Tendulkar's numbers here, for example, cover roughly his last 12 years, not all 24.
- **All-time leaderboards** are effectively "21st century leaderboards." They should not be compared to official ICC career records, which span the full history of the game.
- **Venue and head-to-head records** only reflect matches within the coverage window, not the full historical record at a ground or between two teams.

### What's not limited

Within the coverage window, the data is ball-by-ball — every delivery, every run, every dismissal, every extra. Phase analysis, matchup breakdowns, strike rates, dot ball percentages, and other granular metrics are all derived from actual delivery data, not aggregated scorecards.

## Changelog

### v0.8.0
- **Phase-relative impact scoring**: bowling economy is now scored per-phase against the match's average economy for that phase. Conceding 6 RPO in death overs (where 10+ is typical) earns far more credit than the same economy in middle overs. Batting gets a death-over SR bonus (1.3×) and powerplay aggression bonus (1.1×).

### v0.7.0
- **Player Impact Rating**: 3 new tools (`get_match_impact`, `get_career_impact`, `get_player_form`) that compute context-weighted impact scores combining batting contribution, bowling wicket quality + economy, and fielding
- Impact scores account for: run contribution %, strike rate vs match average, entry difficulty, lost chase discount, wicket quality (set/star batters, top order, partnership breaks), economy vs match run rate, fielding dismissals, match importance (tournament stage + closeness)
- **25 → 28 tools**

### v0.6.0
- **HTTP transport**: `--transport http --port 3000` starts an HTTP server for remote hosting with session management and CORS support
- **Dockerfile**: multi-stage build that ingests data and serves over HTTP — `docker build && docker run` to deploy

### v0.5.0
- Consolidated matchup tools (27 → 25): `get_matchup` now handles specific matchups, batter-vs-team breakdowns, and matchup leaderboards in one tool
- Pre-computed `bowling_style_broad` and `bowling_style_arm` columns during enrichment — eliminates per-row CASE expressions at query time
- Simplified `search_players` to a players-only query (no more JOIN on 10.9M deliveries)
- Added composite indexes on deliveries for wicket and match queries
- Sharpened all 25 tool descriptions with question-led format and cross-references for better LLM tool routing
- Added data coverage documentation with format-specific date ranges

### v0.4.0
- **OneLake backend**: read Delta tables directly from a Microsoft Fabric lakehouse via DuckDB's `delta` + `azure` extensions (`--backend onelake`)
- **Lazy connection initialization**: MCP transport connects immediately; database setup runs in the background. Fixes VS Code MCP client timeouts when OneLake extensions take time to load.
- VS Code `.vscode/mcp.json` configuration documented

### v0.3.0
- Player enrichment pipeline: `npm run enrich` loads batting/bowling style metadata from bundled CSV (16K players from cricketdata R package)
- New `get_style_matchup` tool: query batting stats by bowling style (pace/spin, arm categories) or bowling stats by batting hand
- Schema migration for existing databases — new columns added automatically on startup
- Fixed `BOWLING_WICKET_KINDS` not interpolating in SQL template literals (affected all wicket-counting queries)

### v0.2.0
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
