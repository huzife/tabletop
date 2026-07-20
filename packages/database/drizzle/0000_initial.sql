CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`username_normalized` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`password_changed_at` integer NOT NULL,
	CONSTRAINT "accounts_id_ulid_check" CHECK(length(`id`) = 26),
	CONSTRAINT "accounts_username_length_check" CHECK(length(`username`) BETWEEN 3 AND 32),
	CONSTRAINT "accounts_username_normalized_length_check" CHECK(length(`username_normalized`) BETWEEN 3 AND 32),
	CONSTRAINT "accounts_password_hash_not_empty_check" CHECK(length(`password_hash`) > 0),
	CONSTRAINT "accounts_role_check" CHECK(`role` IN ('admin', 'user')),
	CONSTRAINT "accounts_status_check" CHECK(`status` IN ('enabled', 'disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_username_normalized_unique` ON `accounts` (`username_normalized`);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_single_admin_unique` ON `accounts` (`role`) WHERE `role` = 'admin';
--> statement-breakpoint
CREATE INDEX `accounts_status_idx` ON `accounts` (`status`);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`token_hash` blob NOT NULL,
	`csrf_secret_hash` blob NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sessions_id_ulid_check" CHECK(length(`id`) = 26),
	CONSTRAINT "sessions_token_hash_length_check" CHECK(length(`token_hash`) = 32),
	CONSTRAINT "sessions_csrf_secret_hash_length_check" CHECK(length(`csrf_secret_hash`) = 32),
	CONSTRAINT "sessions_expiry_order_check" CHECK(`expires_at` > `created_at`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `sessions_account_id_idx` ON `sessions` (`account_id`);
--> statement-breakpoint
CREATE INDEX `sessions_expires_at_idx` ON `sessions` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `sessions_revoked_at_idx` ON `sessions` (`revoked_at`) WHERE `revoked_at` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `site_settings` (
	`singleton_id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`maintenance_message` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`updated_by`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "site_settings_singleton_check" CHECK(`singleton_id` = 1),
	CONSTRAINT "site_settings_enabled_check" CHECK(`enabled` IN (0, 1)),
	CONSTRAINT "site_settings_maintenance_message_length_check" CHECK(length(`maintenance_message`) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE `game_service_settings` (
	`game_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`updated_by`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "game_service_settings_game_id_length_check" CHECK(length(`game_id`) BETWEEN 1 AND 64),
	CONSTRAINT "game_service_settings_enabled_check" CHECK(`enabled` IN (0, 1))
);
--> statement-breakpoint
INSERT INTO `site_settings` (`singleton_id`, `enabled`, `maintenance_message`, `updated_at`, `updated_by`)
VALUES (1, 1, '网站维护中，请稍后再试。', 0, NULL);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`actor_account_id` text,
	`actor_username` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`target_label` text,
	`result` text NOT NULL,
	`source_ip` text,
	`request_id` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`actor_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "audit_logs_id_ulid_check" CHECK(length(`id`) = 26),
	CONSTRAINT "audit_logs_actor_username_not_empty_check" CHECK(length(`actor_username`) > 0),
	CONSTRAINT "audit_logs_action_not_empty_check" CHECK(length(`action`) > 0),
	CONSTRAINT "audit_logs_target_type_not_empty_check" CHECK(length(`target_type`) > 0),
	CONSTRAINT "audit_logs_result_check" CHECK(`result` IN ('success', 'failure')),
	CONSTRAINT "audit_logs_request_id_not_empty_check" CHECK(length(`request_id`) > 0),
	CONSTRAINT "audit_logs_metadata_json_check" CHECK(json_valid(`metadata_json`))
);
--> statement-breakpoint
CREATE INDEX `audit_logs_created_at_idx` ON `audit_logs` (`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `audit_logs_actor_created_at_idx` ON `audit_logs` (`actor_account_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `audit_logs_action_created_at_idx` ON `audit_logs` (`action`,`created_at`);
--> statement-breakpoint
CREATE INDEX `audit_logs_target_created_at_idx` ON `audit_logs` (`target_type`,`target_id`,`created_at`);
