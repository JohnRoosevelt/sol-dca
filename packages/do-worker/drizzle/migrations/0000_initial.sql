CREATE TABLE `klines` (
	`id` text PRIMARY KEY NOT NULL,
	`inst_id` text NOT NULL,
	`timeframe` text NOT NULL,
	`open_time` integer NOT NULL,
	`open` real NOT NULL,
	`high` real NOT NULL,
	`low` real NOT NULL,
	`close` real NOT NULL,
	`volume` real NOT NULL
);
--> statement-breakpoint
CREATE TABLE `portfolio_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`usdt_balance` real DEFAULT 0 NOT NULL,
	`sol_holding` real DEFAULT 0 NOT NULL,
	`avg_buy_price` real,
	`last_buy_price` real,
	`total_spent` real DEFAULT 0 NOT NULL,
	`total_sold` real DEFAULT 0 NOT NULL,
	`realized_pnl` real DEFAULT 0 NOT NULL,
	`current_month_spent` real DEFAULT 0 NOT NULL,
	`current_month_reset` text,
	`consecutive_dca_buys` integer DEFAULT 0 NOT NULL,
	`sell_stairs_triggered` text DEFAULT '[]' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `signals` (
	`id` text PRIMARY KEY NOT NULL,
	`price` real NOT NULL,
	`action` text NOT NULL,
	`reason` text NOT NULL,
	`drawdown_pct` real,
	`profit_pct` real,
	`usdt_after` real,
	`sol_after` real,
	`mode` text DEFAULT 'demo' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trades` (
	`id` text PRIMARY KEY NOT NULL,
	`cl_ord_id` text NOT NULL,
	`side` text NOT NULL,
	`price` real NOT NULL,
	`amount_usdt` real NOT NULL,
	`amount_sol` real NOT NULL,
	`reason` text NOT NULL,
	`drawdown_pct` real,
	`multiplier` real,
	`profit_pct` real,
	`mode` text DEFAULT 'demo' NOT NULL,
	`okx_order_id` text,
	`okx_state` text,
	`okx_fee` text,
	`intended_amount_usdt` real,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trades_cl_ord_id_unique` ON `trades` (`cl_ord_id`);
