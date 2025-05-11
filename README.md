# TALKITOIT YOUTUBE VIDEO SUPPORT FILE - NO SUPPORT AND SHOULD NOT BE USED IN PRODUCTION.
## Use at your own risk.

This guide will walk you through setting up a PostgreSQL Model Context Protocol (MCP) server that allows Claude to query and create tables in a PostgreSQL database.

## Prerequisites

- macOS with [Homebrew](https://brew.sh/) installed
- Node.js (v20 or higher)
- Git

## Step 1: Clone the Example MCP Server

First, clone the Model Context Protocol repository with example servers:

````bash
# Clone the MCP examples repository
git clone https://github.com/modelcontextprotocol/servers.git mcp-servers

# Navigate to the PostgreSQL server directory
cd mcp-servers/src/postgres
```∏

## Step 2: Set Up PostgreSQL Database (macOS)

Install and start PostgreSQL using Homebrew:

```bash
# Install PostgreSQL
brew install postgresql@17

# Start PostgreSQL service
brew services start postgresql@17

# Create a database for testing (optional)
createdb mcp_test
````

Test that PostgreSQL is running:

```bash
# Connect to PostgreSQL
psql postgres

# You should see a PostgreSQL prompt
# Type \q to exit
```

## Step 3: Set Up the MCP Server

Create a new directory for your MCP PostgreSQL server:

```bash
mkdir -p ~/postgres-mcp
cd ~/postgres-mcp
```

Initialize a new Node.js project:

```bash
npm init -y
```

Install the required dependencies:

```bash
npm install @modelcontextprotocol/sdk pg typescript ts-node
npm install -D @types/node @types/pg
```

Set up TypeScript configuration:

```bash
npx tsc --init
```

Create a basic project structure:

```bash
mkdir -p src
```

## Step 4: Create the MCP Server with Table Creation Tool

Create the main server file with support for both querying and creating tables:

```bash
touch src/index.ts
```

Replace the content of `src/index.ts` with the following code:

```typescript
#!/usr/bin/env node

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
  }
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
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
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
      [tableName]
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
            columns: { type: "string" },
          },
          required: ["tableName", "columns"],
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
          console.warn("Could not roll back transaction:", error)
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
        content: [
          { type: "text", text: "Error: Table name and columns are required." },
        ],
        isError: true,
      };
    }

    // Table name validation - prevent SQL injection in table names
    // Only allow alphanumeric characters and underscores, must start with a letter
    const tableNameRegex = /^[a-zA-Z][a-zA-Z0-9_]*$/;
    if (!tableNameRegex.test(tableName)) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Table name must start with a letter and contain only alphanumeric characters and underscores.",
          },
        ],
        isError: true,
      };
    }

    // Simple SQL injection check for column definitions
    // Block potentially dangerous SQL commands like DROP or DELETE
    if (
      columns.includes(";") ||
      columns.toLowerCase().includes("drop") ||
      columns.toLowerCase().includes("delete")
    ) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Invalid column definition. Potential SQL injection detected.",
          },
        ],
        isError: true,
      };
    }

    // Execute the CREATE TABLE SQL statement
    const client = await pool.connect();
    try {
      const createTableSQL = `CREATE TABLE ${tableName} (${columns})`;
      await client.query(createTableSQL);
      return {
        content: [
          { type: "text", text: `Table '${tableName}' created successfully.` },
        ],
        isError: false,
      };
    } catch (error) {
      // Return any database errors to the client
      return {
        content: [
          {
            type: "text",
            text: `Error creating table: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
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
```

Update your `package.json` file with the following scripts:

```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js \"postgresql://postgres:postgres@localhost:5432/postgres\"",
    "dev": "ts-node --esm src/index.ts \"postgresql://postgres:postgres@localhost:5432/postgres\""
  },
  "type": "module"
}
```

## Step 5: Build and Run the Server

Build the TypeScript code:

```bash
npm run build
```

Start the server:

```bash
npm run start
```

## Step 6: Test the Server

Create a simple test script to check available tools:

```bash
touch check-tools.js
chmod +x check-tools.js
```

Add the following code to `check-tools.js`:

```javascript
#!/usr/bin/env node

import { exec } from "child_process";
import * as readline from "readline";

// Start the MCP server as a child process
const serverProcess = exec(
  'node dist/index.js "postgresql://postgres:postgres@localhost:5432/postgres"'
);

// Create readline interface for stdin/stdout
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Wait a moment for the server to initialize
setTimeout(() => {
  // Send ListTools request in MCP format
  const request = {
    id: "1",
    jsonrpc: "2.0",
    method: "tools/list",
    params: {},
  };

  console.log(
    "Sending request to MCP server:",
    JSON.stringify(request, null, 2)
  );
  serverProcess.stdin.write(JSON.stringify(request) + "\n");

  // Listen for response from the server
  serverProcess.stdout.on("data", (data) => {
    try {
      const response = JSON.parse(data.toString());
      console.log("Response from MCP server:");
      console.log(JSON.stringify(response, null, 2));

      // Check if 'add' tool is in the list
      if (response.result && response.result.tools) {
        const toolNames = response.result.tools.map((tool) => tool.name);
        console.log("\nAvailable tools:", toolNames.join(", "));

        if (toolNames.includes("add")) {
          console.log('\nThe "add" tool is available!');
        } else {
          console.log('\nThe "add" tool is NOT available.');
        }
      }

      // Exit after receiving response
      setTimeout(() => {
        console.log("Exiting...");
        serverProcess.kill();
        process.exit(0);
      }, 1000);
    } catch (error) {
      console.error("Error parsing response:", error);
    }
  });
}, 1000);

// Handle server process errors
serverProcess.stderr.on("data", (data) => {
  console.error("Server error:", data.toString());
});

// Handle clean exit
process.on("SIGINT", () => {
  serverProcess.kill();
  process.exit();
});
```

Run the test:

```bash
node check-tools.js
```

## Step 7: Configure Claude Desktop to Use Your MCP Server

1. Open Claude Desktop
2. Go to Settings, Developer and Edit Config
3. Paste the below (or add if you have other servers)

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-postgres",
        "postgresql://localhost/postgres"
      ]
    },
    "postgres-local": {
      "command": "node",
      "args": [
        "/Users/bow/workspace/ai/mcp/petk/postegres_mcp/dist/index.js",
        "postgresql://postgres:postgres@localhost:5432/postgres"
      ]
    }
  }
}
```

## Step 8: Using the MCP Server with Claude

Once your PostgreSQL MCP server is connected to Claude, you can use the following tools:

### Query Tool

```
query(sql: "SELECT * FROM your_table LIMIT 10")
```

### Add (Create Table) Tool

```
add(
  tableName: "users",
  columns: "id SERIAL PRIMARY KEY, name TEXT NOT NULL, email VARCHAR(255) UNIQUE"
)
```

## Example Tables Setup

```sql
-- Trading Platform Database Schema
-- This script creates a simulated trading database for crypto and stocks
-- Perfect for portfolio analysis, DevOps, and platform engineering demos

-- First, create the database (run this separately in psql if needed)
-- CREATE DATABASE trading;

-- Connect to the trading database
-- \c trading

-- Drop existing tables if they exist (for clean setup)
DROP TABLE IF EXISTS trade_history;
DROP TABLE IF EXISTS portfolio_snapshots;
DROP TABLE IF EXISTS price_history;
DROP TABLE IF EXISTS watchlists_assets;
DROP TABLE IF EXISTS watchlists;
DROP TABLE IF EXISTS assets;
DROP TABLE IF EXISTS asset_types;
DROP TABLE IF EXISTS asset_categories;
DROP TABLE IF EXISTS exchanges;
DROP TABLE IF EXISTS wallets;
DROP TABLE IF EXISTS user_settings;
DROP TABLE IF EXISTS users;

-- Create Types for Enums
CREATE TYPE trade_type AS ENUM ('buy', 'sell');
CREATE TYPE order_type AS ENUM ('market', 'limit', 'stop', 'stop_limit');
CREATE TYPE time_in_force AS ENUM ('day', 'gtc', 'ioc', 'fok');

-- Create Users table
CREATE TABLE users (
    user_id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(50),
    last_name VARCHAR(50),
    phone VARCHAR(20),
    is_admin BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP WITH TIME ZONE,
    account_status VARCHAR(20) DEFAULT 'active' CHECK (account_status IN ('active', 'suspended', 'deactivated'))
);

-- Create User Settings table
CREATE TABLE user_settings (
    settings_id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
    default_currency VARCHAR(10) DEFAULT 'USD',
    timezone VARCHAR(50) DEFAULT 'UTC',
    enable_notifications BOOLEAN DEFAULT TRUE,
    enable_2fa BOOLEAN DEFAULT FALSE,
    theme VARCHAR(20) DEFAULT 'light',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create Exchanges table
CREATE TABLE exchanges (
    exchange_id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    country VARCHAR(100),
    website VARCHAR(255),
    is_crypto BOOLEAN DEFAULT FALSE,
    is_stock BOOLEAN DEFAULT FALSE,
    trading_fees_url VARCHAR(255),
    api_documentation_url VARCHAR(255),
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create Wallets table
CREATE TABLE wallets (
    wallet_id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
    wallet_name VARCHAR(100) NOT NULL,
    wallet_type VARCHAR(50) CHECK (wallet_type IN ('exchange', 'hardware', 'software', 'paper', 'brokerage')),
    exchange_id INTEGER REFERENCES exchanges(exchange_id) ON DELETE SET NULL,
    address VARCHAR(255),
    balance_usd DECIMAL(20, 2) DEFAULT 0.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create Asset Categories table
CREATE TABLE asset_categories (
    category_id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create Asset Types table
CREATE TABLE asset_types (
    type_id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    category_id INTEGER REFERENCES asset_categories(category_id) ON DELETE SET NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create Assets table
CREATE TABLE assets (
    asset_id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    name VARCHAR(100) NOT NULL,
    type_id INTEGER REFERENCES asset_types(type_id) ON DELETE SET NULL,
    current_price_usd DECIMAL(18, 8),
    market_cap_usd DECIMAL(20, 2),
    circulating_supply DECIMAL(24, 8),
    max_supply DECIMAL(24, 8),
    logo_url VARCHAR(255),
    website VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    launch_date DATE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(symbol, type_id)
);

-- Create Watchlists table
CREATE TABLE watchlists (
    watchlist_id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    is_public BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, name)
);

-- Create Watchlists-Assets junction table
CREATE TABLE watchlists_assets (
    watchlist_id INTEGER REFERENCES watchlists(watchlist_id) ON DELETE CASCADE,
    asset_id INTEGER REFERENCES assets(asset_id) ON DELETE CASCADE,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (watchlist_id, asset_id)
);

-- Create Price History table
CREATE TABLE price_history (
    history_id SERIAL PRIMARY KEY,
    asset_id INTEGER REFERENCES assets(asset_id) ON DELETE CASCADE,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    open_price_usd DECIMAL(18, 8) NOT NULL,
    high_price_usd DECIMAL(18, 8) NOT NULL,
    low_price_usd DECIMAL(18, 8) NOT NULL,
    close_price_usd DECIMAL(18, 8) NOT NULL,
    volume_usd DECIMAL(24, 8) NOT NULL,
    market_cap_usd DECIMAL(24, 8),
    time_period VARCHAR(10) CHECK (time_period IN ('1min', '5min', '15min', '1h', '4h', '1d', '1w', '1m')),
    UNIQUE(asset_id, timestamp, time_period)
);

-- Create Portfolio Snapshots table
CREATE TABLE portfolio_snapshots (
    snapshot_id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
    wallet_id INTEGER REFERENCES wallets(wallet_id) ON DELETE CASCADE,
    asset_id INTEGER REFERENCES assets(asset_id) ON DELETE CASCADE,
    quantity DECIMAL(24, 8) NOT NULL,
    price_per_unit_usd DECIMAL(18, 8) NOT NULL,
    total_value_usd DECIMAL(20, 2) NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, wallet_id, asset_id, timestamp)
);

-- Create Trade History table
CREATE TABLE trade_history (
    trade_id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
    wallet_id INTEGER REFERENCES wallets(wallet_id) ON DELETE CASCADE,
    asset_id INTEGER REFERENCES assets(asset_id) ON DELETE CASCADE,
    exchange_id INTEGER REFERENCES exchanges(exchange_id) ON DELETE SET NULL,
    trade_type trade_type NOT NULL,
    order_type order_type NOT NULL,
    time_in_force time_in_force DEFAULT 'day',
    quantity DECIMAL(24, 8) NOT NULL,
    price_per_unit_usd DECIMAL(18, 8) NOT NULL,
    total_value_usd DECIMAL(20, 2) NOT NULL,
    fee_usd DECIMAL(18, 8) DEFAULT 0,
    trade_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    notes TEXT
);

-- Create indexes for performance
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_assets_symbol ON assets(symbol);
CREATE INDEX idx_assets_type_id ON assets(type_id);
CREATE INDEX idx_price_history_asset_id ON price_history(asset_id);
CREATE INDEX idx_price_history_timestamp ON price_history(timestamp);
CREATE INDEX idx_price_history_time_period ON price_history(time_period);
CREATE INDEX idx_portfolio_snapshots_user_id ON portfolio_snapshots(user_id);
CREATE INDEX idx_portfolio_snapshots_asset_id ON portfolio_snapshots(asset_id);
CREATE INDEX idx_portfolio_snapshots_timestamp ON portfolio_snapshots(timestamp);
CREATE INDEX idx_trade_history_user_id ON trade_history(user_id);
CREATE INDEX idx_trade_history_asset_id ON trade_history(asset_id);
CREATE INDEX idx_trade_history_trade_date ON trade_history(trade_date);
CREATE INDEX idx_trade_history_trade_type ON trade_history(trade_type);

-- Create views for common queries
CREATE OR REPLACE VIEW vw_current_portfolio AS
SELECT
    u.user_id,
    u.username,
    w.wallet_id,
    w.wallet_name,
    a.asset_id,
    a.symbol,
    a.name AS asset_name,
    at.name AS asset_type,
    ac.name AS asset_category,
    ps.quantity,
    a.current_price_usd,
    (ps.quantity * a.current_price_usd) AS current_value_usd,
    ps.price_per_unit_usd AS avg_purchase_price_usd,
    ps.total_value_usd AS total_cost_basis_usd,
    ((ps.quantity * a.current_price_usd) - ps.total_value_usd) AS unrealized_gain_loss_usd,
    CASE
        WHEN ps.total_value_usd > 0
        THEN (((ps.quantity * a.current_price_usd) / ps.total_value_usd) - 1) * 100
        ELSE 0
    END AS percent_return
FROM
    portfolio_snapshots ps
JOIN
    users u ON ps.user_id = u.user_id
JOIN
    wallets w ON ps.wallet_id = w.wallet_id
JOIN
    assets a ON ps.asset_id = a.asset_id
JOIN
    asset_types at ON a.type_id = at.type_id
JOIN
    asset_categories ac ON at.category_id = ac.category_id
WHERE
    ps.timestamp = (
        SELECT MAX(timestamp)
        FROM portfolio_snapshots ps2
        WHERE ps2.user_id = ps.user_id
          AND ps2.wallet_id = ps.wallet_id
          AND ps2.asset_id = ps.asset_id
    );

CREATE OR REPLACE VIEW vw_trade_performance AS
SELECT
    u.user_id,
    u.username,
    a.asset_id,
    a.symbol,
    a.name AS asset_name,
    at.name AS asset_type,
    ac.name AS asset_category,
    e.name AS exchange_name,
    COUNT(CASE WHEN th.trade_type = 'buy' THEN 1 END) AS total_buys,
    COUNT(CASE WHEN th.trade_type = 'sell' THEN 1 END) AS total_sells,
    SUM(CASE WHEN th.trade_type = 'buy' THEN th.quantity ELSE 0 END) AS total_bought,
    SUM(CASE WHEN th.trade_type = 'sell' THEN th.quantity ELSE 0 END) AS total_sold,
    SUM(CASE WHEN th.trade_type = 'buy' THEN th.total_value_usd ELSE 0 END) AS total_invested_usd,
    SUM(CASE WHEN th.trade_type = 'sell' THEN th.total_value_usd ELSE 0 END) AS total_received_usd,
    SUM(CASE WHEN th.trade_type = 'sell' THEN th.total_value_usd ELSE -th.total_value_usd END) AS realized_gain_loss_usd,
    SUM(th.fee_usd) AS total_fees_usd,
    MIN(th.trade_date) AS first_trade_date,
    MAX(th.trade_date) AS last_trade_date
FROM
    trade_history th
JOIN
    users u ON th.user_id = u.user_id
JOIN
    assets a ON th.asset_id = a.asset_id
JOIN
    asset_types at ON a.type_id = at.type_id
JOIN
    asset_categories ac ON at.category_id = ac.category_id
LEFT JOIN
    exchanges e ON th.exchange_id = e.exchange_id
GROUP BY
    u.user_id, u.username, a.asset_id, a.symbol, a.name, at.name, ac.name, e.name;

CREATE OR REPLACE VIEW vw_portfolio_allocation AS
WITH user_totals AS (
    SELECT
        user_id,
        SUM(current_value_usd) AS total_portfolio_value
    FROM
        vw_current_portfolio
    GROUP BY
        user_id
)
SELECT
    p.user_id,
    p.username,
    p.asset_category,
    p.asset_type,
    p.asset_id,
    p.symbol,
    p.asset_name,
    SUM(p.current_value_usd) AS category_value_usd,
    ut.total_portfolio_value,
    (SUM(p.current_value_usd) / ut.total_portfolio_value * 100) AS allocation_percentage
FROM
    vw_current_portfolio p
JOIN
    user_totals ut ON p.user_id = ut.user_id
GROUP BY
    p.user_id, p.username, p.asset_category, p.asset_type, p.asset_id, p.symbol, p.asset_name, ut.total_portfolio_value
ORDER BY
    p.user_id, allocation_percentage DESC;

CREATE OR REPLACE VIEW vw_historical_portfolio_value AS
SELECT
    ps.user_id,
    u.username,
    DATE_TRUNC('day', ps.timestamp) AS date,
    SUM(ps.quantity * ph.close_price_usd) AS portfolio_value_usd
FROM
    portfolio_snapshots ps
JOIN
    users u ON ps.user_id = u.user_id
JOIN
    price_history ph ON ps.asset_id = ph.asset_id
WHERE
    ph.time_period = '1d'
    AND DATE_TRUNC('day', ph.timestamp) = DATE_TRUNC('day', ps.timestamp)
GROUP BY
    ps.user_id, u.username, DATE_TRUNC('day', ps.timestamp)
ORDER BY
    ps.user_id, DATE_TRUNC('day', ps.timestamp);

-- Function to calculate portfolio value at a specific date
CREATE OR REPLACE FUNCTION get_portfolio_value_on_date(
    p_user_id INTEGER,
    p_date DATE
)
RETURNS TABLE (
    portfolio_value_usd DECIMAL(20, 2)
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    WITH latest_snapshots AS (
        SELECT
            ps.asset_id,
            ps.quantity
        FROM
            portfolio_snapshots ps
        WHERE
            ps.user_id = p_user_id
            AND ps.timestamp <= (p_date + INTERVAL '1 day')::TIMESTAMP
        GROUP BY
            ps.asset_id
        HAVING
            MAX(ps.timestamp)
    )
    SELECT
        COALESCE(SUM(ls.quantity * ph.close_price_usd), 0) AS portfolio_value_usd
    FROM
        latest_snapshots ls
    JOIN
        price_history ph ON ls.asset_id = ph.asset_id
    WHERE
        ph.time_period = '1d'
        AND DATE_TRUNC('day', ph.timestamp) = p_date;
END;
$$;

-- Function to calculate ROI for a specific asset
CREATE OR REPLACE FUNCTION calculate_asset_roi(
    p_user_id INTEGER,
    p_asset_id INTEGER
)
RETURNS TABLE (
    symbol VARCHAR(20),
    name VARCHAR(100),
    total_invested DECIMAL(20, 2),
    current_value DECIMAL(20, 2),
    roi_percentage DECIMAL(10, 2),
    holding_period_days INTEGER
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    WITH investment_data AS (
        SELECT
            a.symbol,
            a.name,
            SUM(CASE WHEN th.trade_type = 'buy' THEN th.total_value_usd ELSE 0 END) -
            SUM(CASE WHEN th.trade_type = 'sell' THEN th.total_value_usd ELSE 0 END) AS total_invested,
            SUM(CASE WHEN th.trade_type = 'buy' THEN th.quantity ELSE -th.quantity END) AS current_quantity,
            MIN(th.trade_date) AS first_purchase_date
        FROM
            trade_history th
        JOIN
            assets a ON th.asset_id = a.asset_id
        WHERE
            th.user_id = p_user_id
            AND th.asset_id = p_asset_id
        GROUP BY
            a.symbol, a.name
    )
    SELECT
        id.symbol,
        id.name,
        id.total_invested,
        (id.current_quantity * a.current_price_usd) AS current_value,
        CASE
            WHEN id.total_invested > 0
            THEN ((id.current_quantity * a.current_price_usd) / id.total_invested - 1) * 100
            ELSE 0
        END AS roi_percentage,
        EXTRACT(DAY FROM (CURRENT_TIMESTAMP - id.first_purchase_date)) AS holding_period_days
    FROM
        investment_data id
    JOIN
        assets a ON a.symbol = id.symbol;
END;
$$;
```

## Example Mock Data Seeding

```sql
-- Trading Platform Sample Data
-- This script populates the trading database with realistic sample data
-- Perfect for portfolio analysis, DevOps, and platform engineering demos

-- Insert Users
INSERT INTO users (username, email, password_hash, first_name, last_name, phone, is_admin, last_login, account_status)
VALUES
    ('alextrader', 'alex.trader@example.com', '$2a$12$1234567890123456789012', 'Alex', 'Trader', '555-123-4567', FALSE, CURRENT_TIMESTAMP - INTERVAL '2 days', 'active'),
    ('sarahinvestor', 'sarah.investor@example.com', '$2a$12$2345678901234567890123', 'Sarah', 'Investor', '555-234-5678', FALSE, CURRENT_TIMESTAMP - INTERVAL '5 days', 'active'),
    ('adminuser', 'admin@example.com', '$2a$12$3456789012345678901234', 'Admin', 'User', '555-345-6789', TRUE, CURRENT_TIMESTAMP - INTERVAL '1 day', 'active'),
    ('mikecrypto', 'mike.crypto@example.com', '$2a$12$4567890123456789012345', 'Mike', 'Crypto', '555-456-7890', FALSE, CURRENT_TIMESTAMP - INTERVAL '10 days', 'active'),
    ('emilystocks', 'emily.stocks@example.com', '$2a$12$5678901234567890123456', 'Emily', 'Stocks', '555-567-8901', FALSE, CURRENT_TIMESTAMP - INTERVAL '7 days', 'active');

-- Insert User Settings
INSERT INTO user_settings (user_id, default_currency, timezone, enable_notifications, enable_2fa, theme)
VALUES
    (1, 'USD', 'America/New_York', TRUE, TRUE, 'dark'),
    (2, 'EUR', 'Europe/London', TRUE, FALSE, 'light'),
    (3, 'USD', 'America/Los_Angeles', TRUE, TRUE, 'dark'),
    (4, 'USD', 'Asia/Tokyo', FALSE, TRUE, 'dark'),
    (5, 'GBP', 'Europe/London', TRUE, FALSE, 'light');

-- Insert Exchanges
INSERT INTO exchanges (name, country, website, is_crypto, is_stock, trading_fees_url, api_documentation_url, status)
VALUES
    ('Coinbase', 'USA', 'https://www.coinbase.com', TRUE, FALSE, 'https://www.coinbase.com/fees', 'https://developers.coinbase.com', 'active'),
    ('Binance', 'Malta', 'https://www.binance.com', TRUE, FALSE, 'https://www.binance.com/en/fee/schedule', 'https://binance-docs.github.io/apidocs', 'active'),
    ('NYSE', 'USA', 'https://www.nyse.com', FALSE, TRUE, 'https://www.nyse.com/markets/fees', 'https://www.nyse.com/connectivity/specs', 'active'),
    ('NASDAQ', 'USA', 'https://www.nasdaq.com', FALSE, TRUE, 'https://www.nasdaq.com/solutions/exchange-traded-products-listing-fees', 'https://www.nasdaq.com/solutions/market-data-apis', 'active'),
    ('Kraken', 'USA', 'https://www.kraken.com', TRUE, FALSE, 'https://www.kraken.com/features/fee-schedule', 'https://docs.kraken.com/rest', 'active'),
    ('Interactive Brokers', 'USA', 'https://www.interactivebrokers.com', FALSE, TRUE, 'https://www.interactivebrokers.com/en/pricing/index.php', 'https://www.interactivebrokers.com/en/index.php?f=5041', 'active');

-- Insert Wallets
INSERT INTO wallets (user_id, wallet_name, wallet_type, exchange_id, address, balance_usd)
VALUES
    (1, 'Coinbase Pro', 'exchange', 1, NULL, 25000.00),
    (1, 'Ledger Nano X', 'hardware', NULL, '0x1234567890abcdef1234567890abcdef12345678', 15000.00),
    (1, 'Interactive Brokers', 'brokerage', 6, NULL, 35000.00),
    (2, 'Binance', 'exchange', 2, NULL, 18000.00),
    (2, 'Schwab Brokerage', 'brokerage', NULL, NULL, 75000.00),
    (3, 'Admin Exchange Account', 'exchange', 1, NULL, 5000.00),
    (4, 'Kraken Pro', 'exchange', 5, NULL, 30000.00),
    (4, 'Trezor', 'hardware', NULL, 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', 45000.00),
    (5, 'Fidelity', 'brokerage', NULL, NULL, 125000.00),
    (5, 'Robin Hood', 'brokerage', NULL, NULL, 15000.00);

-- Insert Asset Categories
INSERT INTO asset_categories (name, description)
VALUES
    ('Cryptocurrency', 'Digital or virtual currencies that use cryptography for security'),
    ('Stocks', 'Shares of ownership in a company'),
    ('ETFs', 'Exchange Traded Funds that track indexes, commodities, or baskets of assets'),
    ('Commodities', 'Raw materials or primary agricultural products'),
    ('Forex', 'Foreign exchange market for trading currencies');

-- Insert Asset Types
INSERT INTO asset_types (name, category_id, description)
VALUES
    ('Layer 1 Blockchain', 1, 'Base blockchain protocols that operate their own network'),
    ('Layer 2 Solution', 1, 'Solutions built on top of layer 1 blockchains to improve scalability'),
    ('DeFi Token', 1, 'Tokens used in decentralized finance applications'),
    ('Tech Stock', 2, 'Stocks from technology companies'),
    ('Finance Stock', 2, 'Stocks from financial services companies'),
    ('Healthcare Stock', 2, 'Stocks from healthcare companies'),
    ('Index ETF', 3, 'ETFs that track market indices'),
    ('Sector ETF', 3, 'ETFs that focus on specific industry sectors'),
    ('Precious Metal', 4, 'Rare, naturally occurring metallic elements'),
    ('Energy Commodity', 4, 'Commodities related to energy production'),
    ('Major Pair', 5, 'Currency pairs involving the US dollar and one of the major currencies');

-- Insert Assets
INSERT INTO assets (symbol, name, type_id, current_price_usd, market_cap_usd, circulating_supply, max_supply, logo_url, website, launch_date)
VALUES
    -- Cryptocurrencies
    ('BTC', 'Bitcoin', 1, 55000.00, 1050000000000, 19000000, 21000000, 'https://example.com/logos/btc.png', 'https://bitcoin.org', '2009-01-03'),
    ('ETH', 'Ethereum', 1, 3000.00, 360000000000, 120000000, NULL, 'https://example.com/logos/eth.png', 'https://ethereum.org', '2015-07-30'),
    ('SOL', 'Solana', 1, 90.00, 36000000000, 400000000, NULL, 'https://example.com/logos/sol.png', 'https://solana.com', '2020-03-16'),
    ('LINK', 'Chainlink', 2, 15.00, 7500000000, 500000000, 1000000000, 'https://example.com/logos/link.png', 'https://chain.link', '2017-09-19'),
    ('UNI', 'Uniswap', 3, 10.00, 5000000000, 500000000, 1000000000, 'https://example.com/logos/uni.png', 'https://uniswap.org', '2020-09-17'),
    ('AAVE', 'Aave', 3, 80.00, 1200000000, 15000000, 16000000, 'https://example.com/logos/aave.png', 'https://aave.com', '2020-10-02'),

    -- Stocks
    ('AAPL', 'Apple Inc.', 4, 180.00, 2800000000000, NULL, NULL, 'https://example.com/logos/aapl.png', 'https://www.apple.com', '1980-12-12'),
    ('MSFT', 'Microsoft Corporation', 4, 330.00, 2500000000000, NULL, NULL, 'https://example.com/logos/msft.png', 'https://www.microsoft.com', '1986-03-13'),
    ('GOOGL', 'Alphabet Inc.', 4, 2800.00, 1850000000000, NULL, NULL, 'https://example.com/logos/googl.png', 'https://www.google.com', '2004-08-19'),
    ('JPM', 'JPMorgan Chase & Co.', 5, 145.00, 425000000000, NULL, NULL, 'https://example.com/logos/jpm.png', 'https://www.jpmorganchase.com', '1968-09-24'),
    ('BAC', 'Bank of America Corporation', 5, 38.00, 300000000000, NULL, NULL, 'https://example.com/logos/bac.png', 'https://www.bankofamerica.com', '1986-01-01'),
    ('JNJ', 'Johnson & Johnson', 6, 160.00, 420000000000, NULL, NULL, 'https://example.com/logos/jnj.png', 'https://www.jnj.com', '1944-09-24'),

    -- ETFs
    ('SPY', 'SPDR S&P 500 ETF Trust', 7, 430.00, NULL, NULL, NULL, 'https://example.com/logos/spy.png', 'https://www.ssga.com/us/en/individual/etfs/funds/spdr-sp-500-etf-trust-spy', '1993-01-22'),
    ('QQQ', 'Invesco QQQ Trust', 7, 370.00, NULL, NULL, NULL, 'https://example.com/logos/qqq.png', 'https://www.invesco.com/us/financial-products/etfs/product-detail?audienceType=Investor&ticker=QQQ', '1999-03-10'),
    ('XLF', 'Financial Select Sector SPDR Fund', 8, 36.00, NULL, NULL, NULL, 'https://example.com/logos/xlf.png', 'https://www.ssga.com/us/en/individual/etfs/funds/the-financial-select-sector-spdr-fund-xlf', '1998-12-16'),

    -- Commodities
    ('GLD', 'SPDR Gold Shares', 9, 170.00, NULL, NULL, NULL, 'https://example.com/logos/gld.png', 'https://www.spdrgoldshares.com', '2004-11-18'),
    ('SLV', 'iShares Silver Trust', 9, 22.00, NULL, NULL, NULL, 'https://example.com/logos/slv.png', 'https://www.ishares.com/us/products/239855/ishares-silver-trust-fund', '2006-04-21'),
    ('USO', 'United States Oil Fund', 10, 75.00, NULL, NULL, NULL, 'https://example.com/logos/uso.png', 'https://www.uscfinvestments.com/uso', '2006-04-10'),

    -- Forex
    ('EUR/USD', 'Euro / US Dollar', 11, 1.09, NULL, NULL, NULL, 'https://example.com/logos/eurusd.png', NULL, NULL),
    ('GBP/USD', 'British Pound / US Dollar', 11, 1.27, NULL, NULL, NULL, 'https://example.com/logos/gbpusd.png', NULL, NULL);

-- Insert Watchlists
INSERT INTO watchlists (user_id, name, description, is_public)
VALUES
    (1, 'Crypto Favorites', 'My top cryptocurrency picks', FALSE),
    (1, 'Tech Stocks', 'Technology companies I follow', FALSE),
    (2, 'Long Term Investments', 'Assets for retirement portfolio', FALSE),
    (3, 'Market Tracking', 'Broad market indicators', TRUE),
    (4, 'DeFi Tokens', 'Decentralized Finance tokens to watch', TRUE),
    (5, 'Dividend Stocks', 'Stocks with good dividend yields', FALSE);

-- Insert Watchlists-Assets
INSERT INTO watchlists_assets (watchlist_id, asset_id)
VALUES
    (1, 1), (1, 2), (1, 3), (1, 4), (1, 5),  -- Crypto Favorites
    (2, 7), (2, 8), (2, 9),  -- Tech Stocks
    (3, 7), (3, 8), (3, 12), (3, 13), (3, 16),  -- Long Term Investments
    (4, 13), (4, 14), (4, 19), (4, 20),  -- Market Tracking
    (5, 5), (5, 6),  -- DeFi Tokens
    (6, 10), (6, 11), (6, 12);  -- Dividend Stocks

-- Insert Price History (simplified for brevity, would have thousands of records in reality)
INSERT INTO price_history (asset_id, timestamp, open_price_usd, high_price_usd, low_price_usd, close_price_usd, volume_usd, market_cap_usd, time_period)
VALUES
    -- Bitcoin daily prices for the last 10 days
    (1, CURRENT_DATE - INTERVAL '10 days', 52000.00, 53000.00, 51500.00, 52800.00, 28000000000, 1002000000000, '1d'),
    (1, CURRENT_DATE - INTERVAL '9 days', 52800.00, 54000.00, 52500.00, 53700.00, 30000000000, 1020300000000, '1d'),
    (1, CURRENT_DATE - INTERVAL '8 days', 53700.00, 54200.00, 52800.00, 53500.00, 29000000000, 1016500000000, '1d'),
    (1, CURRENT_DATE - INTERVAL '7 days', 53500.00, 55000.00, 53200.00, 54800.00, 32000000000, 1041200000000, '1d'),
    (1, CURRENT_DATE - INTERVAL '6 days', 54800.00, 56000.00, 54500.00, 55500.00, 35000000000, 1054500000000, '1d'),
    (1, CURRENT_DATE - INTERVAL '5 days', 55500.00, 55800.00, 54000.00, 54200.00, 30000000000, 1029800000000, '1d'),
    (1, CURRENT_DATE - INTERVAL '4 days', 54200.00, 54500.00, 53500.00, 54000.00, 28000000000, 1026000000000, '1d'),
    (1, CURRENT_DATE - INTERVAL '3 days', 54000.00, 55000.00, 53800.00, 54500.00, 29000000000, 1035500000000, '1d'),
    (1, CURRENT_DATE - INTERVAL '2 days', 54500.00, 56000.00, 54200.00, 55800.00, 33000000000, 1060200000000, '1d'),
    (1, CURRENT_DATE - INTERVAL '1 day', 55800.00, 56500.00, 54800.00, 55000.00, 31000000000, 1045000000000, '1d'),

    -- Ethereum daily prices for the last 10 days
    (2, CURRENT_DATE - INTERVAL '10 days', 2800.00, 2850.00, 2750.00, 2820.00, 15000000000, 338400000000, '1d'),
    (2, CURRENT_DATE - INTERVAL '9 days', 2820.00, 2900.00, 2800.00, 2880.00, 16000000000, 345600000000, '1d'),
    (2, CURRENT_DATE - INTERVAL '8 days', 2880.00, 2950.00, 2860.00, 2900.00, 17000000000, 348000000000, '1d'),
    (2, CURRENT_DATE - INTERVAL '7 days', 2900.00, 3000.00, 2880.00, 2980.00, 18000000000, 357600000000, '1d'),
    (2, CURRENT_DATE - INTERVAL '6 days', 2980.00, 3050.00, 2950.00, 3020.00, 19000000000, 362400000000, '1d'),
    (2, CURRENT_DATE - INTERVAL '5 days', 3020.00, 3080.00, 3000.00, 3050.00, 18500000000, 366000000000, '1d'),
    (2, CURRENT_DATE - INTERVAL '4 days', 3050.00, 3100.00, 3020.00, 3080.00, 18000000000, 369600000000, '1d'),
    (2, CURRENT_DATE - INTERVAL '3 days', 3080.00, 3120.00, 3000.00, 3030.00, 17000000000, 363600000000, '1d'),
    (2, CURRENT_DATE - INTERVAL '2 days', 3030.00, 3080.00, 2980.00, 3050.00, 16500000000, 366000000000, '1d'),
    (2, CURRENT_DATE - INTERVAL '1 day', 3050.00, 3100.00, 2950.00, 3000.00, 17000000000, 360000000000, '1d'),

    -- Apple daily prices for the last 10 days
    (7, CURRENT_DATE - INTERVAL '10 days', 175.00, 177.00, 174.00, 176.50, 8000000000, 2740000000000, '1d'),
    (7, CURRENT_DATE - INTERVAL '9 days', 176.50, 178.00, 175.50, 177.20, 7500000000, 2751600000000, '1d'),
    (7, CURRENT_DATE - INTERVAL '8 days', 177.20, 179.00, 176.00, 178.50, 8200000000, 2772000000000, '1d'),
    (7, CURRENT_DATE - INTERVAL '7 days', 178.50, 180.00, 177.50, 179.80, 8500000000, 2793200000000, '1d'),
    (7, CURRENT_DATE - INTERVAL '6 days', 179.80, 181.50, 179.00, 181.00, 9000000000, 2812000000000, '1d'),
    (7, CURRENT_DATE - INTERVAL '5 days', 181.00, 182.00, 179.50, 180.20, 8800000000, 2799200000000, '1d'),
    (7, CURRENT_DATE - INTERVAL '4 days', 180.20, 182.50, 179.80, 182.00, 9200000000, 2827200000000, '1d'),
    (7, CURRENT_DATE - INTERVAL '3 days', 182.00, 183.00, 180.00, 181.50, 8700000000, 2819600000000, '1d'),
    (7, CURRENT_DATE - INTERVAL '2 days', 181.50, 182.00, 179.00, 179.50, 8300000000, 2788600000000, '1d'),
    (7, CURRENT_DATE - INTERVAL '1 day', 179.50, 181.00, 178.50, 180.00, 8500000000, 2796000000000, '1d'),

    -- S&P 500 ETF daily prices for the last 10 days
    (13, CURRENT_DATE - INTERVAL '10 days', 422.00, 424.00, 421.00, 423.50, 5000000000, NULL, '1d'),
    (13, CURRENT_DATE - INTERVAL '9 days', 423.50, 425.00, 422.50, 424.80, 4800000000, NULL, '1d'),
    (13, CURRENT_DATE - INTERVAL '8 days', 424.80, 426.00, 424.00, 425.50, 4700000000, NULL, '1d'),
    (13, CURRENT_DATE - INTERVAL '7 days', 425.50, 427.00, 425.00, 426.70, 4900000000, NULL, '1d'),
    (13, CURRENT_DATE - INTERVAL '6 days', 426.70, 428.50, 426.00, 428.00, 5100000000, NULL, '1d'),
    (13, CURRENT_DATE - INTERVAL '5 days', 428.00, 429.00, 427.00, 428.20, 4800000000, NULL, '1d'),
    (13, CURRENT_DATE - INTERVAL '4 days', 428.20, 430.00, 427.50, 429.50, 5000000000, NULL, '1d'),
    (13, CURRENT_DATE - INTERVAL '3 days', 429.50, 431.00, 429.00, 430.20, 5200000000, NULL, '1d'),
    (13, CURRENT_DATE - INTERVAL '2 days', 430.20, 432.00, 428.00, 428.50, 5300000000, NULL, '1d'),
    (13, CURRENT_DATE - INTERVAL '1 day', 428.50, 430.00, 427.00, 430.00, 5000000000, NULL, '1d');

-- Insert Portfolio Snapshots
INSERT INTO portfolio_snapshots (user_id, wallet_id, asset_id, quantity, price_per_unit_usd, total_value_usd, timestamp)
VALUES
    -- Alex's portfolio
    (1, 1, 1, 0.5, 48000.00, 24000.00, CURRENT_TIMESTAMP - INTERVAL '30 days'),  -- BTC on Coinbase Pro
    (1, 1, 1, 0.5, 55000.00, 27500.00, CURRENT_TIMESTAMP),  -- BTC on Coinbase Pro (updated)
    (1, 1, 2, 5.0, 2800.00, 14000.00, CURRENT_TIMESTAMP),  -- ETH on Coinbase Pro
    (1, 2, 3, 50.0, 85.00, 4250.00, CURRENT_TIMESTAMP),  -- SOL on Ledger
    (1, 2, 4, 200.0, 14.00, 2800.00, CURRENT_TIMESTAMP),  -- LINK on Ledger
    (1, 3, 7, 25.0, 170.00, 4250.00, CURRENT_TIMESTAMP),  -- AAPL stocks
    (1, 3, 8, 10.0, 320.00, 3200.00, CURRENT_TIMESTAMP),  -- MSFT stocks
    (1, 3, 13, 50.0, 425.00, 21250.00, CURRENT_TIMESTAMP),  -- SPY ETF

    -- Sarah's portfolio
    (2, 4, 1, 0.3, 50000.00, 15000.00, CURRENT_TIMESTAMP),  -- BTC on Binance
    (2, 4, 5, 100.0, 9.50, 950.00, CURRENT_TIMESTAMP),  -- UNI on Binance
    (2, 5, 7, 100.0, 172.00, 17200.00, CURRENT_TIMESTAMP),  -- AAPL stocks
    (2, 5, 10, 50.0, 140.00, 7000.00, CURRENT_TIMESTAMP),  -- JPM stocks
    (2, 5, 12, 30.0, 155.00, 4650.00, CURRENT_TIMESTAMP),  -- JNJ stocks
    (2, 5, 13, 100.0, 420.00, 42000.00, CURRENT_TIMESTAMP),  -- SPY ETF

    -- Mike's crypto portfolio
    (4, 7, 1, 0.8, 52000.00, 41600.00, CURRENT_TIMESTAMP),  -- BTC on Kraken
    (4, 7, 2, 10.0, 2850.00, 28500.00, CURRENT_TIMESTAMP),  -- ETH on Kraken
    (4, 8, 1, 0.2, 51000.00, 10200.00, CURRENT_TIMESTAMP),  -- BTC on Trezor
    (4, 8, 2, 5.0, 2800.00, 14000.00, CURRENT_TIMESTAMP),  -- ETH on Trezor
    (4, 8, 3, 200.0, 85.00, 17000.00, CURRENT_TIMESTAMP),  -- SOL on Trezor
    (4, 8, 5, 300.0, 9.50, 2850.00, CURRENT_TIMESTAMP),  -- UNI on Trezor

    -- Emily's stock portfolio
    (5, 9, 7, 200.0, 165.00, 33000.00, CURRENT_TIMESTAMP),  -- AAPL stocks
    (5, 9, 8, 50.0, 310.00, 15500.00, CURRENT_TIMESTAMP),  -- MSFT stocks
    (5, 9, 9, 10.0, 2750.00, 27500.00, CURRENT_TIMESTAMP),  -- GOOGL stocks
    (5, 9, 10, 100.0, 138.00, 13800.00, CURRENT_TIMESTAMP),  -- JPM stocks
    (5, 9, 13, 75.0, 415.00, 31125.00, CURRENT_TIMESTAMP),  -- SPY ETF
    (5, 10, 16, 50.0, 165.00, 8250.00, CURRENT_TIMESTAMP),  -- GLD ETF
    (5, 10, 17, 100.0, 20.00, 2000.00, CURRENT_TIMESTAMP);  -- SLV ETF

-- Insert Trade History
INSERT INTO trade_history (user_id, wallet_id, asset_id, exchange_id, trade_type, order_type, time_in_force, quantity, price_per_unit_usd, total_value_usd, fee_usd, trade_date, notes)
VALUES
    -- Alex's trades
    (1, 1, 1, 1, 'buy', 'market', 'day', 0.2, 45000.00, 9000.00, 45.00, CURRENT_TIMESTAMP - INTERVAL '60 days', 'Initial BTC position'),
    (1, 1, 1, 1, 'buy', 'limit', 'gtc', 0.3, 47000.00, 14100.00, 70.50, CURRENT_TIMESTAMP - INTERVAL '40 days', 'Buying the dip'),
    (1, 1, 2, 1, 'buy', 'market', 'day', 5.0, 2800.00, 14000.00, 70.00, CURRENT_TIMESTAMP - INTERVAL '30 days', 'Initial ETH position'),
    (1, 2, 3, 1, 'buy', 'market', 'day', 50.0, 85.00, 4250.00, 21.25, CURRENT_TIMESTAMP - INTERVAL '20 days', 'Initial SOL position'),
    (1, 2, 4, 1, 'buy', 'market', 'day', 200.0, 14.00, 2800.00, 14.00, CURRENT_TIMESTAMP - INTERVAL '15 days', 'Initial LINK position'),
    (1, 3, 7, 6, 'buy', 'limit', 'day', 25.0, 170.00, 4250.00, 4.25, CURRENT_TIMESTAMP - INTERVAL '45 days', 'Initial AAPL position'),
    (1, 3, 8, 6, 'buy', 'limit', 'day', 10.0, 320.00, 3200.00, 3.20, CURRENT_TIMESTAMP - INTERVAL '40 days', 'Initial MSFT position'),
    (1, 3, 13, 6, 'buy', 'market', 'day', 25.0, 420.00, 10500.00, 10.50, CURRENT_TIMESTAMP - INTERVAL '35 days', 'Initial SPY position'),
    (1, 3, 13, 6, 'buy', 'market', 'day', 25.0, 430.00, 10750.00, 10.75, CURRENT_TIMESTAMP - INTERVAL '10 days', 'Adding to SPY position'),

    -- Sarah's trades
    (2, 4, 1, 2, 'buy', 'market', 'day', 0.3, 50000.00, 15000.00, 75.00, CURRENT_TIMESTAMP - INTERVAL '25 days', 'Initial BTC position'),
    (2, 4, 5, 2, 'buy', 'limit', 'gtc', 100.0, 9.50, 950.00, 4.75, CURRENT_TIMESTAMP - INTERVAL '20 days', 'Initial UNI position'),
    (2, 5, 7, NULL, 'buy', 'market', 'day', 50.0, 165.00, 8250.00, 8.25, CURRENT_TIMESTAMP - INTERVAL '120 days', 'Initial AAPL position'),
    (2, 5, 7, NULL, 'buy', 'market', 'day', 50.0, 172.00, 8600.00, 8.60, CURRENT_TIMESTAMP - INTERVAL '60 days', 'Adding to AAPL position'),
    (2, 5, 10, NULL, 'buy', 'limit', 'day', 50.0, 140.00, 7000.00, 7.00, CURRENT_TIMESTAMP - INTERVAL '90 days', 'Initial JPM position'),
    (2, 5, 12, NULL, 'buy', 'market', 'day', 30.0, 155.00, 4650.00, 4.65, CURRENT_TIMESTAMP - INTERVAL '80 days', 'Initial JNJ position'),
    (2, 5, 13, NULL, 'buy', 'market', 'day', 50.0, 400.00, 20000.00, 20.00, CURRENT_TIMESTAMP - INTERVAL '180 days', 'Initial SPY position'),
    (2, 5, 13, NULL, 'buy', 'market', 'day', 50.0, 425.00, 21250.00, 21.25, CURRENT_TIMESTAMP - INTERVAL '30 days', 'Adding to SPY position'),

    -- Mike's trades
    (4, 7, 1, 5, 'buy', 'market', 'day', 0.8, 52000.00, 41600.00, 208.00, CURRENT_TIMESTAMP - INTERVAL '45 days', 'Initial BTC position'),
    (4, 7, 2, 5, 'buy', 'limit', 'gtc', 10.0, 2850.00, 28500.00, 142.50, CURRENT_TIMESTAMP - INTERVAL '40 days', 'Initial ETH position'),
    (4, 8, 1, 5, 'buy', 'market', 'day', 0.2, 51000.00, 10200.00, 51.00, CURRENT_TIMESTAMP - INTERVAL '30 days', 'Moving some BTC to cold storage'),
    (4, 8, 2, 5, 'buy', 'market', 'day', 5.0, 2800.00, 14000.00, 70.00, CURRENT_TIMESTAMP - INTERVAL '25 days', 'Moving some ETH to cold storage'),
    (4, 8, 3, 5, 'buy', 'limit', 'gtc', 200.0, 85.00, 17000.00, 85.00, CURRENT_TIMESTAMP - INTERVAL '15 days', 'Initial SOL position'),
    (4, 8, 5, 5, 'buy', 'market', 'day', 300.0, 9.50, 2850.00, 14.25, CURRENT_TIMESTAMP - INTERVAL '10 days', 'Initial UNI position'),

    -- Emily's trades
    (5, 9, 7, NULL, 'buy', 'market', 'day', 100.0, 150.00, 15000.00, 15.00, CURRENT_TIMESTAMP - INTERVAL '365 days', 'Initial AAPL position'),
    (5, 9, 7, NULL, 'buy', 'market', 'day', 100.0, 180.00, 18000.00, 18.00, CURRENT_TIMESTAMP - INTERVAL '90 days', 'Adding to AAPL position'),
    (5, 9, 8, NULL, 'buy', 'market', 'day', 50.0, 310.00, 15500.00, 15.50, CURRENT_TIMESTAMP - INTERVAL '180 days', 'Initial MSFT position'),
    (5, 9, 9, NULL, 'buy', 'limit', 'gtc', 10.0, 2750.00, 27500.00, 27.50, CURRENT_TIMESTAMP - INTERVAL '120 days', 'Initial GOOGL position'),
    (5, 9, 10, NULL, 'buy', 'market', 'day', 100.0, 138.00, 13800.00, 13.80, CURRENT_TIMESTAMP - INTERVAL '150 days', 'Initial JPM position'),
    (5, 9, 13, NULL, 'buy', 'market', 'day', 75.0, 415.00, 31125.00, 31.13, CURRENT_TIMESTAMP - INTERVAL '730 days', 'Long-term SPY position'),
    (5, 10, 16, NULL, 'buy', 'market', 'day', 50.0, 165.00, 8250.00, 8.25, CURRENT_TIMESTAMP - INTERVAL '60 days', 'Gold as inflation hedge'),
    (5, 10, 17, NULL, 'buy', 'market', 'day', 100.0, 20.00, 2000.00, 2.00, CURRENT_TIMESTAMP - INTERVAL '45 days', 'Silver as inflation hedge');
```

## Troubleshooting

### Database Connection Issues

If you have trouble connecting to the PostgreSQL database:

1. Ensure PostgreSQL is running: `brew services list`
2. Check your connection string: `postgresql://username:password@localhost:5432/database_name`
3. Try connecting directly: `psql postgresql://username:password@localhost:5432/database_name`

### MCP Server Issues

If Claude doesn't show the PostgreSQL tools:

1. Check that your MCP server is running correctly
2. Run the test script to confirm tools are available: `node check-tools.js`
3. Restart Claude Desktop

### PostgreSQL User Permissions

If you get permission errors:

```bash
# If using postgres default database, you may need to create a new role (when trying to connect via pgadmin4)
CREATE ROLE postgres WITH LOGIN SUPERUSER PASSWORD 'your_password';

# Create a new PostgreSQL user with appropriate permissions
createuser -s mcp_user -P

# Then update your connection string to use this user
```

## Additional Resources

- [Model Context Protocol Documentation](https://modelcontextprotocol.io)
- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [Claude Documentation](https://docs.anthropic.com/)
