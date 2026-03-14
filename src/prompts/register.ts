import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerAllPrompts(server: McpServer): void {
  registerPreMatchBriefing(server);
  registerPlayerProfile(server);
}

function registerPreMatchBriefing(server: McpServer): void {
  server.registerPrompt(
    "pre_match_briefing",
    {
      title: "Pre-match briefing",
      description:
        "Comprehensive preview for an upcoming match between two teams. Covers head-to-head record, recent form, venue stats, toss analysis, and key player matchups.",
      argsSchema: {
        team1: z.string().describe("First team (e.g. 'India')"),
        team2: z.string().describe("Second team (e.g. 'Australia')"),
        format: z
          .enum(["Test", "ODI", "T20", "IT20"])
          .describe("Match format"),
        venue: z
          .string()
          .optional()
          .describe("Venue or city (optional, e.g. 'MCG' or 'Melbourne')"),
      },
    },
    async (args) => {
      const venueClause = args.venue
        ? ` at ${args.venue}`
        : "";

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                `Build a pre-match briefing for ${args.team1} vs ${args.team2} in ${args.format}s${venueClause}.`,
                "",
                "Use the available tools to cover:",
                `1. Head-to-head record between ${args.team1} and ${args.team2} in ${args.format}s`,
                `2. Recent form for both ${args.team1} and ${args.team2} (last 10 ${args.format} matches)`,
                ...(args.venue
                  ? [
                      `3. Venue stats for ${args.venue} in ${args.format}s`,
                      `4. Toss analysis at ${args.venue} in ${args.format}s`,
                    ]
                  : [
                      "3. Skip venue stats (no venue specified)",
                      "4. Skip toss analysis (no venue specified)",
                    ]),
                `5. Top batting performers from each team in recent ${args.format}s`,
                `6. Top bowling performers from each team in recent ${args.format}s`,
                "",
                "Present it as a concise briefing with sections. Call out any notable streaks, dominant matchups, or venue trends.",
              ].join("\n"),
            },
          },
        ],
      };
    }
  );
}

function registerPlayerProfile(server: McpServer): void {
  server.registerPrompt(
    "player_profile",
    {
      title: "Player profile",
      description:
        "Deep profile of a player: career stats, season-by-season trend, how they get out, strengths vs bowling styles, and recent form.",
      argsSchema: {
        player_name: z.string().describe("Player name (e.g. 'Virat Kohli')"),
        format: z
          .enum(["Test", "ODI", "T20", "IT20"])
          .optional()
          .describe("Format to focus on (optional, covers all if omitted)"),
      },
    },
    async (args) => {
      const formatClause = args.format
        ? ` in ${args.format}s`
        : " across formats";

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                `Build a comprehensive player profile for ${args.player_name}${formatClause}.`,
                "",
                "Use the available tools to cover:",
                `1. Player search to confirm full name, role, batting/bowling style`,
                `2. Career batting stats${formatClause}`,
                `3. Career bowling stats${formatClause} (if they bowl)`,
                `4. Season-by-season batting trend${formatClause}`,
                `5. Dismissal analysis — how do they get out?`,
                `6. Style matchup — performance vs pace vs spin`,
                "",
                "Present it as a player profile. Highlight career trajectory, peak seasons, weaknesses, and any notable patterns.",
              ].join("\n"),
            },
          },
        ],
      };
    }
  );
}
