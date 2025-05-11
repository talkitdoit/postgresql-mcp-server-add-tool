// this is an example of adding a new tool called 'add' to a publicly available MCP server.
// the original MCP server code can be found here: https://github.com/modelcontextprotocol/servers/blob/main/src/postgres

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import pg from "pg";

const server = new Server(
  {
    name: "example-servers/postgres",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  },
);

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Please provide a database URL as a command-line argument");
  process.exit(1);
}

const databaseUrl = args[0];

const resourceBaseUrl = new URL(databaseUrl);
resourceBaseUrl.protocol = "postgres:";
resourceBaseUrl.password = "";

const pool = new pg.Pool({
  connectionString: databaseUrl,
});

const SCHEMA_PATH = "schema";

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    return {
      resources: result.rows.map((row) => ({
        uri: new URL(`${row.table_name}/${SCHEMA_PATH}`, resourceBaseUrl).href,
        mimeType: "application/json",
        name: `"${row.table_name}" database schema`,
      })),
    };
  } finally {
    client.release();
  }
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const resourceUrl = new URL(request.params.uri);

  const pathComponents = resourceUrl.pathname.split("/");
  const schema = pathComponents.pop();
  const tableName = pathComponents.pop();

  if (schema !== SCHEMA_PATH) {
    throw new Error("Invalid resource URI");
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1",
      [tableName],
    );

    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "application/json",
          text: JSON.stringify(result.rows, null, 2),
        },
      ],
    };
  } finally {
    client.release();
  }
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "query",
        description: "Run a read-only SQL query",
        inputSchema: {
          type: "object",
          properties: {
            sql: { type: "string" },
          },
        },
      },
      // FEATURE ADDITION: New 'add' tool for creating database tables
      // This tool allows Claude to create new tables in the PostgreSQL database
      // The tool takes a table name and column definitions as parameters
      {
        name: "add",
        description: "Create a new database table",
        inputSchema: {
          type: "object",
          properties: {
            tableName: { type: "string" },
            columns: { type: "string" }
          },
          required: ["tableName", "columns"]
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "query") {
    const sql = request.params.arguments?.sql as string;

    const client = await pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      const result = await client.query(sql);
      return {
        content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
        isError: false,
      };
    } catch (error) {
      throw error;
    } finally {
      client
        .query("ROLLBACK")
        .catch((error) =>
          console.warn("Could not roll back transaction:", error),
        );

      client.release();
    }
  }
  // FEATURE ADDITION: Handler for the 'add' tool that creates new database tables
  // This implements the actual functionality for the 'add' tool defined above
  else if (request.params.name === "add") {
    const tableName = request.params.arguments?.tableName as string;
    const columns = request.params.arguments?.columns as string;

    // Basic validation - ensure required parameters are provided
    if (!tableName || !columns) {
      return {
        content: [{ type: "text", text: "Error: Table name and columns are required." }],
        isError: true,
      };
    }

    // Table name validation - prevent SQL injection in table names
    // Only allow alphanumeric characters and underscores, must start with a letter
    const tableNameRegex = /^[a-zA-Z][a-zA-Z0-9_]*$/;
    if (!tableNameRegex.test(tableName)) {
      return {
        content: [{ type: "text", text: "Error: Table name must start with a letter and contain only alphanumeric characters and underscores." }],
        isError: true,
      };
    }

    // Simple SQL injection check for column definitions
    // Block potentially dangerous SQL commands like DROP or DELETE
    if (columns.includes(";") || columns.toLowerCase().includes("drop") || columns.toLowerCase().includes("delete")) {
      return {
        content: [{ type: "text", text: "Error: Invalid column definition. Potential SQL injection detected." }],
        isError: true,
      };
    }

    // Execute the CREATE TABLE SQL statement
    const client = await pool.connect();
    try {
      const createTableSQL = `CREATE TABLE ${tableName} (${columns})`;
      await client.query(createTableSQL);
      return {
        content: [{ type: "text", text: `Table '${tableName}' created successfully.` }],
        isError: false,
      };
    } catch (error) {
      // Return any database errors to the client
      return {
        content: [{ type: "text", text: `Error creating table: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    } finally {
      // Always release the database connection
      client.release();
    }
  }
  throw new Error(`Unknown tool: ${request.params.name}`);
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch(console.error);