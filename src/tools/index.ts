import { FastMCP } from "fastmcp";
import { z } from "zod";
import { createExecuteSqlToolHandler, executeSqlSchema } from "./execute-sql.js";
import { createSearchDatabaseObjectsToolHandler, searchDatabaseObjectsSchema } from "./search-objects.js";
import { ConnectorManager } from "../connectors/manager.js";
import { getExecuteSqlMetadata, getSearchObjectsMetadata } from "../utils/tool-metadata.js";
import { isReadOnlySQL } from "../utils/allowed-keywords.js";
import { createCustomToolHandler, buildZodSchemaFromParameters } from "./custom-tool-handler.js";
import type { ToolConfig, CustomToolConfig } from "../types/config.js";
import { getToolRegistry } from "./registry.js";
import { BUILTIN_TOOL_EXECUTE_SQL, BUILTIN_TOOL_SEARCH_OBJECTS } from "./builtin-tools.js";

/**
 * Register all tool handlers with the FastMCP server
 * Iterates through all enabled tools from the registry and registers them
 * @param server - The FastMCP server instance
 */
export function registerTools(server: FastMCP): void {
  const sourceIds = ConnectorManager.getAvailableSourceIds();

  if (sourceIds.length === 0) {
    throw new Error("No database sources configured");
  }

  const registry = getToolRegistry();

  // Register all enabled tools (both built-in and custom) for each source
  for (const sourceId of sourceIds) {
    const enabledTools = registry.getToolsForSource(sourceId);
    const sourceConfig = ConnectorManager.getSourceConfig(sourceId)!;
    const dbType = sourceConfig.type;
    const isDefault = sourceIds[0] === sourceId;

    for (const toolConfig of enabledTools) {
      // Register based on tool name (built-in vs custom)
      if (toolConfig.name === BUILTIN_TOOL_EXECUTE_SQL) {
        registerExecuteSqlTool(server, sourceId, dbType);
      } else if (toolConfig.name === BUILTIN_TOOL_SEARCH_OBJECTS) {
        registerSearchObjectsTool(server, sourceId, dbType, isDefault);
      } else {
        // Custom tool
        registerCustomTool(server, toolConfig as CustomToolConfig, dbType);
      }
    }
  }
}

/**
 * Register execute_sql tool for a source
 */
function registerExecuteSqlTool(
  server: FastMCP,
  sourceId: string,
  _dbType: string
): void {
  const metadata = getExecuteSqlMetadata(sourceId);
  const handler = createExecuteSqlToolHandler(sourceId);

  server.addTool({
    name: metadata.name,
    description: metadata.description,
    parameters: z.object(executeSqlSchema),
    annotations: metadata.annotations,
    execute: async (args) => {
      return handler(args, {});
    },
  });
}

/**
 * Register search_objects tool for a source
 */
function registerSearchObjectsTool(
  server: FastMCP,
  sourceId: string,
  dbType: string,
  isDefault: boolean
): void {
  const metadata = getSearchObjectsMetadata(sourceId, dbType, isDefault);
  const handler = createSearchDatabaseObjectsToolHandler(sourceId);

  server.addTool({
    name: metadata.name,
    description: metadata.description,
    parameters: z.object(searchDatabaseObjectsSchema),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    execute: async (args) => {
      return handler(args, {});
    },
  });
}

/**
 * Register a custom tool
 */
function registerCustomTool(
  server: FastMCP,
  toolConfig: CustomToolConfig,
  dbType: string
): void {
  const isReadOnly = isReadOnlySQL(toolConfig.statement, dbType);
  const zodSchemaShape = buildZodSchemaFromParameters(toolConfig.parameters);
  const handler = createCustomToolHandler(toolConfig);

  server.addTool({
    name: toolConfig.name,
    description: toolConfig.description,
    parameters: z.object(zodSchemaShape),
    annotations: {
      readOnlyHint: isReadOnly,
      destructiveHint: !isReadOnly,
      idempotentHint: isReadOnly,
      openWorldHint: false,
    },
    execute: async (args) => {
      return handler(args, {});
    },
  });

  console.error(`  - ${toolConfig.name} → ${toolConfig.source} (${dbType})`);
}
