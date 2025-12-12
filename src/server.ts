import { FastMCP } from "fastmcp";
import { GoogleProvider } from "fastmcp/auth";
import path from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

import { ConnectorManager } from "./connectors/manager.js";
import { ConnectorRegistry } from "./connectors/interface.js";
import { resolveTransport, resolvePort, redactDSN, resolveSourceConfigs, isDemoMode } from "./config/env.js";
import { buildDSNFromSource } from "./config/toml-loader.js";
import { registerTools } from "./tools/index.js";
import { generateStartupTable, buildSourceDisplayInfo } from "./utils/startup-table.js";
import { getToolsForSource } from "./utils/tool-metadata.js";

// Create __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load package.json to get version
const packageJsonPath = path.join(__dirname, "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

// Server info
export const SERVER_NAME = "DBHub MCP Server";
export const SERVER_VERSION = packageJson.version;

/**
 * Generate ASCII art banner with version information
 */
export function generateBanner(version: string, modes: string[] = []): string {
  // Create a mode string that includes all active modes
  const modeText = modes.length > 0 ? ` [${modes.join(' | ')}]` : '';

  return `
 _____  ____  _   _       _
|  __ \\|  _ \\| | | |     | |
| |  | | |_) | |_| |_   _| |__
| |  | |  _ <|  _  | | | | '_ \\
| |__| | |_) | | | | |_| | |_) |
|_____/|____/|_| |_|\\__,_|_.__/

v${version}${modeText} - Universal Database MCP Server
`;
}

/**
 * Resolve OAuth configuration from environment variables
 */
function resolveOAuthConfig(): {
  enabled: boolean;
  clientId?: string;
  clientSecret?: string;
  baseUrl?: string;
} {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const baseUrl = process.env.OAUTH_BASE_URL;

  // OAuth is enabled only if all required env vars are present
  const enabled = !!(clientId && clientSecret && baseUrl);

  return {
    enabled,
    clientId,
    clientSecret,
    baseUrl,
  };
}

/**
 * Initialize and start the DBHub server
 */
export async function main(): Promise<void> {
  try {
    // Resolve source configurations from TOML or fallback to single DSN
    const sourceConfigsData = await resolveSourceConfigs();

    if (!sourceConfigsData) {
      const samples = ConnectorRegistry.getAllSampleDSNs();
      const sampleFormats = Object.entries(samples)
        .map(([id, dsn]) => `  - ${id}: ${dsn}`)
        .join("\n");

      console.error(`
ERROR: Database connection configuration is required.
Please provide configuration in one of these ways (in order of priority):

1. Use demo mode: --demo (uses in-memory SQLite with sample employee database)
2. TOML config file: --config=path/to/dbhub.toml or ./dbhub.toml
3. Command line argument: --dsn="your-connection-string"
4. Environment variable: export DSN="your-connection-string"
5. .env file: DSN=your-connection-string

Example DSN formats:
${sampleFormats}

Example TOML config (dbhub.toml):
  [[sources]]
  id = "my_db"
  dsn = "postgres://user:pass@localhost:5432/dbname"

See documentation for more details on configuring database connections.
`);
      process.exit(1);
    }

    // Create connector manager and connect to database(s)
    const connectorManager = new ConnectorManager();
    const sources = sourceConfigsData.sources;

    console.error(`Configuration source: ${sourceConfigsData.source}`);

    // Connect to database(s) - works uniformly for all modes (demo, single DSN, multi-source TOML)
    console.error(`Connecting to ${sources.length} database source(s)...`);
    for (const source of sources) {
      const dsn = source.dsn || buildDSNFromSource(source);
      console.error(`  - ${source.id}: ${redactDSN(dsn)}`);
    }
    await connectorManager.connectWithSources(sources);

    // Initialize tool registry (manages both built-in and custom tools)
    // This must happen AFTER ConnectorManager is initialized so source validation works
    const { initializeToolRegistry } = await import("./tools/registry.js");
    initializeToolRegistry({
      sources: sourceConfigsData.sources,
      tools: sourceConfigsData.tools,
    });
    console.error("Tool registry initialized");

    // Initialize custom tool registry early (needed for API routes)
    // Only initialize once (idempotent - safe for multiple MCP client connections)
    if (sourceConfigsData.tools && sourceConfigsData.tools.length > 0) {
      const { customToolRegistry } = await import("./tools/custom-tool-registry.js");
      const { BUILTIN_TOOLS } = await import("./tools/builtin-tools.js");

      if (!customToolRegistry.isInitialized()) {
        // Filter out built-in tools - custom tool registry only handles custom tools
        const customTools = sourceConfigsData.tools.filter(
          (tool) => !(BUILTIN_TOOLS as readonly string[]).includes(tool.name)
        ) as import("./types/config.js").CustomToolConfig[];

        if (customTools.length > 0) {
          customToolRegistry.initialize(customTools);
          console.error(`Custom tool registry initialized with ${customTools.length} tool(s)`);
        }
      }
    }

    // Resolve transport type
    const transportData = resolveTransport();
    const transportType = transportData.type;

    // Resolve port for HTTP server (only needed for http transport)
    const port = transportType === "http" ? resolvePort().port : 8080;

    // Resolve OAuth configuration
    const oauthConfig = resolveOAuthConfig();

    // Print ASCII art banner with version and slogan
    // Collect active modes
    const activeModes: string[] = [];
    const modeDescriptions: string[] = [];
    const isDemo = isDemoMode();

    if (isDemo) {
      activeModes.push("DEMO");
      modeDescriptions.push("using sample employee database");
    }

    if (transportType === "http" && oauthConfig.enabled) {
      activeModes.push("OAuth");
      modeDescriptions.push("Google OAuth 2.1 enabled");
    }

    // Output mode information
    if (activeModes.length > 0) {
      console.error(`Running in ${activeModes.join(' and ')} mode - ${modeDescriptions.join(', ')}`);
    }

    console.error(generateBanner(SERVER_VERSION, activeModes));

    // Print sources and tools table
    const sourceDisplayInfos = buildSourceDisplayInfo(
      sources,
      (sourceId) => getToolsForSource(sourceId).map((t) => t.name),
      isDemo
    );
    console.error(generateStartupTable(sourceDisplayInfos));

    // Create FastMCP server with OAuth for HTTP transport
    let oauthProxy: GoogleProvider | undefined;

    if (transportType === "http" && oauthConfig.enabled) {
      oauthProxy = new GoogleProvider({
        clientId: oauthConfig.clientId!,
        clientSecret: oauthConfig.clientSecret!,
        baseUrl: oauthConfig.baseUrl!,
        scopes: ["openid", "profile", "email"],
      });
    }

    const server = new FastMCP({
      name: SERVER_NAME,
      version: SERVER_VERSION as `${number}.${number}.${number}`,
      oauth: (transportType === "http" && oauthProxy) ? {
        enabled: true,
        authorizationServer: oauthProxy.getAuthorizationServerMetadata(),
        proxy: oauthProxy,
      } : undefined,
    });

    // Register tools with FastMCP
    registerTools(server);

    // Start with appropriate transport
    if (transportType === "http") {
      await server.start({
        transportType: "httpStream",
        httpStream: {
          port,
          stateless: true,
          host: "0.0.0.0",
        },
      });

      if (oauthConfig.enabled) {
        console.error(`OAuth endpoints available at http://0.0.0.0:${port}/oauth/*`);
      }
      console.error(`MCP server endpoint at http://0.0.0.0:${port}/mcp`);
    } else {
      // STDIO transport: Pure MCP-over-stdio
      await server.start({ transportType: "stdio" });
      console.error("MCP server running on stdio");
    }

    // Listen for SIGINT to gracefully shut down
    process.on("SIGINT", async () => {
      console.error("Shutting down...");
      await server.stop();
      process.exit(0);
    });
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
}
