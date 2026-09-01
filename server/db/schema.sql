-- ============================================================================
-- KnoBitz — base database schema (structure only, no data)
-- Regenerated from production via: mysqldump --no-data --routines --triggers
-- Last regenerated: 2026-09-01
--
-- Purpose: bootstrap a completely fresh, empty database. server/db/migrate.js
-- runs this automatically, and ONLY this, when it detects no base tables
-- exist yet (checks for `users`) — on any database that already has tables,
-- this file is never touched, migrate.js goes straight to its normal
-- additive ALTER/CREATE-IF-NOT-EXISTS steps instead. Never run this file by
-- hand against a database that already has data — every table here starts
-- with DROP TABLE IF EXISTS, which is exactly what mysqldump produces and
-- exactly what you do not want against a populated database.
--
-- Ported from themapofknowledge.com's 2026-09-01 security/resilience
-- review — that repo had no way to bootstrap a fresh database either; same
-- gap existed here (migrate.js only ever did additive ALTER TABLE/CREATE
-- TABLE IF NOT EXISTS against tables assumed to already exist).
--
-- To regenerate this file after a schema change: run the same mysqldump
-- command above against production and replace everything below this
-- header (see docs/operations.md's Database section for the exact command
-- with credentials — that file is local-only/gitignored, this one is not).
-- ============================================================================

/*M!999999\- enable the sandbox mode */

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*M!100616 SET @OLD_NOTE_VERBOSITY=@@NOTE_VERBOSITY, NOTE_VERBOSITY=0 */;
DROP TABLE IF EXISTS `anne_messages`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `anne_messages` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `passport_id` bigint(20) unsigned NOT NULL,
  `role` enum('user','assistant') NOT NULL,
  `content` longtext NOT NULL,
  `locale` char(2) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_anne_messages_passport` (`passport_id`,`id`),
  CONSTRAINT `fk_anne_msg_passport` FOREIGN KEY (`passport_id`) REFERENCES `learner_passports` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=81 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `edges`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `edges` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `source_node_id` bigint(20) unsigned NOT NULL,
  `target_node_id` bigint(20) unsigned NOT NULL,
  `edge_type` enum('hierarchy','cross_layer','draws_from') NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_edges` (`source_node_id`,`target_node_id`,`edge_type`),
  KEY `idx_edges_source` (`source_node_id`),
  KEY `idx_edges_target` (`target_node_id`),
  CONSTRAINT `fk_edges_source` FOREIGN KEY (`source_node_id`) REFERENCES `nodes` (`id`),
  CONSTRAINT `fk_edges_target` FOREIGN KEY (`target_node_id`) REFERENCES `nodes` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=5446 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `knobit_interactions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `knobit_interactions` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `passport_id` bigint(20) unsigned NOT NULL,
  `knobit_id` bigint(20) unsigned NOT NULL,
  `phase` enum('explain','demonstrate','practice','meaning') NOT NULL,
  `block_type` enum('byte','example','practice','feedback','meaning','user','note','visual','personal_note') NOT NULL,
  `block_index` tinyint(3) unsigned NOT NULL,
  `choice_made` varchar(50) DEFAULT NULL,
  `answer_text` text DEFAULT NULL,
  `content` longtext DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `fk_kint_knobit` (`knobit_id`),
  KEY `idx_knobit_interactions_passport` (`passport_id`,`knobit_id`),
  CONSTRAINT `fk_kint_knobit` FOREIGN KEY (`knobit_id`) REFERENCES `knobits` (`id`),
  CONSTRAINT `fk_kint_passport` FOREIGN KEY (`passport_id`) REFERENCES `learner_passports` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=1613 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `knobit_progress`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `knobit_progress` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `passport_id` bigint(20) unsigned NOT NULL,
  `knobit_id` bigint(20) unsigned NOT NULL,
  `phase_reached` enum('explain','demonstrate','practice','meaning','done') NOT NULL,
  `started_at` datetime DEFAULT NULL,
  `assess_correct` tinyint(1) DEFAULT NULL,
  `completed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_knobit_progress` (`passport_id`,`knobit_id`),
  KEY `idx_knobit_progress_passport` (`passport_id`),
  KEY `idx_knobit_progress_knobit` (`knobit_id`),
  CONSTRAINT `fk_kprog_knobit` FOREIGN KEY (`knobit_id`) REFERENCES `knobits` (`id`),
  CONSTRAINT `fk_kprog_passport` FOREIGN KEY (`passport_id`) REFERENCES `learner_passports` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=130 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `knobit_translations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `knobit_translations` (
  `knobit_id` bigint(20) unsigned NOT NULL,
  `locale` varchar(10) NOT NULL,
  `title` varchar(255) NOT NULL,
  PRIMARY KEY (`knobit_id`,`locale`),
  CONSTRAINT `fk_ktrans_knobit` FOREIGN KEY (`knobit_id`) REFERENCES `knobits` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `knobits`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `knobits` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `node_id` bigint(20) unsigned NOT NULL,
  `sequence` tinyint(3) unsigned NOT NULL,
  `locale` varchar(10) NOT NULL,
  `title` varchar(255) NOT NULL,
  `target_bytes` tinyint(3) unsigned DEFAULT NULL,
  `content_explain` text DEFAULT NULL,
  `content_demonstrate` text DEFAULT NULL,
  `content_practice` text DEFAULT NULL,
  `content_meaning` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_knobits` (`node_id`,`sequence`,`locale`),
  KEY `idx_knobits_node_locale` (`node_id`,`locale`),
  CONSTRAINT `fk_knobits_node` FOREIGN KEY (`node_id`) REFERENCES `nodes` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=743 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `knowledge_subset_nodes`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `knowledge_subset_nodes` (
  `subset_id` bigint(20) unsigned NOT NULL,
  `node_id` bigint(20) unsigned NOT NULL,
  PRIMARY KEY (`subset_id`,`node_id`),
  KEY `idx_ksubnode_node` (`node_id`),
  CONSTRAINT `fk_ksubnode_node` FOREIGN KEY (`node_id`) REFERENCES `nodes` (`id`),
  CONSTRAINT `fk_ksubnode_subset` FOREIGN KEY (`subset_id`) REFERENCES `knowledge_subsets` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `knowledge_subsets`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `knowledge_subsets` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `description` text DEFAULT NULL,
  `icon_color` varchar(20) NOT NULL DEFAULT 'terra',
  `background_hidden` tinyint(1) NOT NULL DEFAULT 0,
  `display_mode` enum('color','ring') NOT NULL DEFAULT 'color',
  `is_overlay` tinyint(1) NOT NULL DEFAULT 0,
  `ring_color` varchar(7) NOT NULL DEFAULT '#9B8FB5',
  `source_url` varchar(500) DEFAULT NULL,
  `version` varchar(50) DEFAULT NULL,
  `type` enum('personal','public','shared') NOT NULL DEFAULT 'personal',
  `created_by` bigint(20) unsigned DEFAULT NULL,
  `locale` varchar(10) NOT NULL DEFAULT 'et',
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `fk_ksub_creator` (`created_by`),
  KEY `idx_ksub_type_active` (`type`,`is_active`),
  CONSTRAINT `fk_ksub_creator` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=15 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `learner_links`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `learner_links` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `passport_id` bigint(20) unsigned DEFAULT NULL,
  `linked_user_id` bigint(20) unsigned DEFAULT NULL,
  `role` enum('parent','teacher') NOT NULL,
  `status` enum('pending','active','revoked') NOT NULL DEFAULT 'pending',
  `invite_code` char(8) DEFAULT NULL,
  `invited_at` datetime NOT NULL DEFAULT current_timestamp(),
  `accepted_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_link` (`passport_id`,`linked_user_id`,`role`),
  KEY `fk_ll_user` (`linked_user_id`),
  CONSTRAINT `fk_ll_passport` FOREIGN KEY (`passport_id`) REFERENCES `learner_passports` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ll_user` FOREIGN KEY (`linked_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=11 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `learner_passports`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `learner_passports` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `public_id` char(36) NOT NULL,
  `display_name` varchar(255) DEFAULT NULL,
  `birth_year` smallint(6) DEFAULT NULL,
  `location` varchar(255) DEFAULT NULL,
  `cultural_background` varchar(255) DEFAULT NULL,
  `id_number` varchar(100) DEFAULT NULL,
  `about` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp(),
  `lumen_total` int(10) unsigned NOT NULL DEFAULT 0,
  `profile_bonus_awarded` tinyint(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_passport_public_id` (`public_id`)
) ENGINE=InnoDB AUTO_INCREMENT=34 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `llm_usage_log`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `llm_usage_log` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint(20) unsigned DEFAULT NULL,
  `call_type` enum('byte','rephrase','practice_feedback','ask','import','path_generate') NOT NULL,
  `input_tokens` int(10) unsigned NOT NULL,
  `output_tokens` int(10) unsigned NOT NULL,
  `model` varchar(100) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_llm_usage_user_time` (`user_id`,`created_at` DESC),
  KEY `idx_llm_usage_time` (`created_at` DESC),
  CONSTRAINT `fk_llm_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `lootbox_cache`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `lootbox_cache` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `node_external_id` varchar(20) NOT NULL,
  `locale` varchar(10) NOT NULL DEFAULT 'en',
  `data` mediumtext NOT NULL,
  `generated_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_lootbox` (`node_external_id`,`locale`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `lumen_transactions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `lumen_transactions` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `passport_id` bigint(20) unsigned NOT NULL,
  `amount` int(11) NOT NULL,
  `reason` varchar(60) NOT NULL,
  `reference_id` varchar(255) DEFAULT NULL,
  `multiplier` decimal(4,2) NOT NULL DEFAULT 1.00,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_passport` (`passport_id`),
  KEY `idx_reason` (`reason`)
) ENGINE=InnoDB AUTO_INCREMENT=106 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `node_child_order`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `node_child_order` (
  `parent_node_id` bigint(20) unsigned NOT NULL,
  `child_node_id` bigint(20) unsigned NOT NULL,
  `position` tinyint(3) unsigned NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`parent_node_id`,`child_node_id`),
  KEY `fk_nco_child` (`child_node_id`),
  CONSTRAINT `fk_nco_child` FOREIGN KEY (`child_node_id`) REFERENCES `nodes` (`id`),
  CONSTRAINT `fk_nco_parent` FOREIGN KEY (`parent_node_id`) REFERENCES `nodes` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `node_overview_translations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `node_overview_translations` (
  `node_external_id` varchar(20) NOT NULL,
  `locale` varchar(10) NOT NULL,
  `overview` text NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`node_external_id`,`locale`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `node_translations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `node_translations` (
  `node_external_id` varchar(20) NOT NULL,
  `locale` varchar(10) NOT NULL,
  `label` varchar(255) NOT NULL,
  PRIMARY KEY (`node_external_id`,`locale`),
  KEY `idx_locale` (`locale`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `nodes`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `nodes` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `external_id` varchar(20) DEFAULT NULL,
  `label` varchar(255) NOT NULL,
  `level` tinyint(3) unsigned NOT NULL,
  `layer` enum('foundational','emergent') NOT NULL,
  `parent_id` bigint(20) unsigned DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `overview` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_nodes_external_id` (`external_id`),
  KEY `idx_nodes_parent` (`parent_id`),
  KEY `idx_nodes_layer_level` (`layer`,`level`),
  KEY `idx_nodes_active` (`is_active`),
  CONSTRAINT `fk_nodes_parent` FOREIGN KEY (`parent_id`) REFERENCES `nodes` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=5469 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `notifications`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `notifications` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint(20) unsigned NOT NULL,
  `type` varchar(50) NOT NULL,
  `title` varchar(255) NOT NULL,
  `body` text DEFAULT NULL,
  `node_external_id` varchar(20) DEFAULT NULL,
  `icon_color` varchar(20) NOT NULL DEFAULT 'terra',
  `is_read` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_notifications_user_read` (`user_id`,`is_read`,`created_at` DESC),
  CONSTRAINT `fk_notif_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=379 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `oauth_identities`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `oauth_identities` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint(20) unsigned NOT NULL,
  `provider` enum('google') NOT NULL,
  `provider_id` varchar(255) NOT NULL,
  `provider_email` varchar(255) DEFAULT NULL,
  `linked_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_oauth_provider` (`provider`,`provider_id`),
  KEY `fk_oauth_user` (`user_id`),
  CONSTRAINT `fk_oauth_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `passport_aspirations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `passport_aspirations` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `passport_id` bigint(20) unsigned NOT NULL,
  `text` text NOT NULL,
  `sort_order` tinyint(3) unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `fk_pasps_passport` (`passport_id`),
  CONSTRAINT `fk_pasps_passport` FOREIGN KEY (`passport_id`) REFERENCES `learner_passports` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `passport_competence`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `passport_competence` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `passport_id` bigint(20) unsigned NOT NULL,
  `type` enum('knowledge','skill','language') NOT NULL,
  `name` varchar(255) NOT NULL,
  `description` text DEFAULT NULL,
  `level` tinyint(3) unsigned NOT NULL,
  `proficiency_label` varchar(20) DEFAULT NULL,
  `source` enum('tested','self_reported','predicted') NOT NULL DEFAULT 'self_reported',
  `sort_order` smallint(6) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_passport_competence_passport` (`passport_id`,`type`),
  CONSTRAINT `fk_pcomp_passport` FOREIGN KEY (`passport_id`) REFERENCES `learner_passports` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `passport_credentials`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `passport_credentials` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `passport_id` bigint(20) unsigned NOT NULL,
  `type` enum('platform','qualification','certification','award') NOT NULL,
  `title` varchar(255) NOT NULL,
  `issuer` varchar(255) DEFAULT NULL,
  `awarded_date` date DEFAULT NULL,
  `grade` varchar(100) DEFAULT NULL,
  `score_pct` tinyint(3) unsigned DEFAULT NULL,
  `threshold_pct` tinyint(3) unsigned DEFAULT NULL,
  `blockchain_hash` varchar(255) DEFAULT NULL,
  `verify_url` varchar(500) DEFAULT NULL,
  `sort_order` smallint(6) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_passport_credentials_passport` (`passport_id`,`type`),
  CONSTRAINT `fk_pcreds_passport` FOREIGN KEY (`passport_id`) REFERENCES `learner_passports` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=8 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `passport_events`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `passport_events` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `passport_id` bigint(20) unsigned NOT NULL,
  `event_date` date DEFAULT NULL,
  `title` varchar(255) NOT NULL,
  `institution` varchar(255) DEFAULT NULL,
  `result` varchar(255) DEFAULT NULL,
  `node_external_id` varchar(64) DEFAULT NULL,
  `type` enum('activity','assessment','evidence') NOT NULL,
  `sort_order` smallint(6) NOT NULL DEFAULT 0,
  `user_created` tinyint(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_passport_events_passport` (`passport_id`,`event_date` DESC),
  CONSTRAINT `fk_pevents_passport` FOREIGN KEY (`passport_id`) REFERENCES `learner_passports` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=272 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `passport_goals`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `passport_goals` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `passport_id` bigint(20) unsigned NOT NULL,
  `text` text NOT NULL,
  `node_external_id` varchar(50) DEFAULT NULL,
  `node_breadcrumb` varchar(200) DEFAULT NULL,
  `target_date` date DEFAULT NULL,
  `suggested_by_user_id` bigint(20) unsigned DEFAULT NULL,
  `status` enum('in_progress','completed') NOT NULL DEFAULT 'in_progress',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `completed_at` datetime DEFAULT NULL,
  `sort_order` smallint(6) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_passport_goals` (`passport_id`)
) ENGINE=InnoDB AUTO_INCREMENT=8 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `passport_learning_style`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `passport_learning_style` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `passport_id` bigint(20) unsigned NOT NULL,
  `modalities` varchar(255) DEFAULT NULL,
  `peak_time` varchar(100) DEFAULT NULL,
  `session_length` varchar(100) DEFAULT NULL,
  `works_best` text DEFAULT NULL,
  `needs` text DEFAULT NULL,
  `accessibility` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_pls_passport` (`passport_id`),
  CONSTRAINT `fk_pls_passport` FOREIGN KEY (`passport_id`) REFERENCES `learner_passports` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `passport_objectives`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `passport_objectives` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `passport_id` bigint(20) unsigned NOT NULL,
  `title` varchar(255) NOT NULL,
  `target_date` date DEFAULT NULL,
  `target_description` varchar(500) DEFAULT NULL,
  `status` enum('active','completed') NOT NULL DEFAULT 'active',
  `sort_order` smallint(6) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `fk_pobjs_passport` (`passport_id`),
  CONSTRAINT `fk_pobjs_passport` FOREIGN KEY (`passport_id`) REFERENCES `learner_passports` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `passport_plans`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `passport_plans` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `passport_id` bigint(20) unsigned NOT NULL,
  `frequency` varchar(50) NOT NULL,
  `title` varchar(255) NOT NULL,
  `description` text DEFAULT NULL,
  `sort_order` smallint(6) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `fk_pplans_passport` (`passport_id`),
  CONSTRAINT `fk_pplans_passport` FOREIGN KEY (`passport_id`) REFERENCES `learner_passports` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `passport_reflections`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `passport_reflections` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `passport_id` bigint(20) unsigned NOT NULL,
  `event_id` bigint(20) unsigned DEFAULT NULL,
  `text` text NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `fk_prefl_passport` (`passport_id`),
  KEY `fk_reflection_event` (`event_id`),
  CONSTRAINT `fk_prefl_passport` FOREIGN KEY (`passport_id`) REFERENCES `learner_passports` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_reflection_event` FOREIGN KEY (`event_id`) REFERENCES `passport_events` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `passport_relationships`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `passport_relationships` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `passport_id` bigint(20) unsigned NOT NULL,
  `type` enum('individual','group','institution','tool') NOT NULL,
  `name` varchar(255) NOT NULL,
  `role_description` varchar(500) DEFAULT NULL,
  `status` enum('active','concluded') DEFAULT NULL,
  `is_primary` tinyint(1) NOT NULL DEFAULT 0,
  `sort_order` smallint(6) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `fk_prelations_passport` (`passport_id`),
  CONSTRAINT `fk_prelations_passport` FOREIGN KEY (`passport_id`) REFERENCES `learner_passports` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `passport_tags`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `passport_tags` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `passport_id` bigint(20) unsigned NOT NULL,
  `type` enum('interest','value') NOT NULL,
  `text` varchar(255) NOT NULL,
  `sort_order` tinyint(3) unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_passport_tags_passport` (`passport_id`,`type`),
  CONSTRAINT `fk_ptags_passport` FOREIGN KEY (`passport_id`) REFERENCES `learner_passports` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=120 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `subset_import_staging`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `subset_import_staging` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `subset_id` bigint(20) unsigned NOT NULL,
  `input_term` varchar(500) NOT NULL,
  `input_breadcrumb` varchar(500) DEFAULT NULL,
  `matched_node_id` bigint(20) unsigned DEFAULT NULL,
  `match_method` enum('exact','breadcrumb','llm','manual') DEFAULT NULL,
  `confidence` tinyint(3) unsigned DEFAULT NULL,
  `status` enum('pending','accepted','rejected','ambiguous','no_match') NOT NULL DEFAULT 'pending',
  `candidates_json` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `fk_staging_subset` (`subset_id`),
  CONSTRAINT `fk_staging_subset` FOREIGN KEY (`subset_id`) REFERENCES `knowledge_subsets` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `teacher_group_members`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `teacher_group_members` (
  `group_id` bigint(20) unsigned NOT NULL,
  `passport_id` bigint(20) unsigned NOT NULL,
  `added_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`group_id`,`passport_id`),
  KEY `fk_tgm_passport` (`passport_id`),
  CONSTRAINT `fk_tgm_group` FOREIGN KEY (`group_id`) REFERENCES `teacher_groups` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_tgm_passport` FOREIGN KEY (`passport_id`) REFERENCES `learner_passports` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `teacher_groups`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `teacher_groups` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `teacher_user_id` bigint(20) unsigned NOT NULL,
  `label` varchar(60) NOT NULL,
  `color` varchar(7) NOT NULL DEFAULT '#8BAD7E',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_tg_teacher` (`teacher_user_id`),
  CONSTRAINT `fk_tg_teacher` FOREIGN KEY (`teacher_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `token_usage`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `token_usage` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint(20) unsigned NOT NULL,
  `call_type` varchar(40) NOT NULL,
  `input_tokens` int(11) NOT NULL DEFAULT 0,
  `output_tokens` int(11) NOT NULL DEFAULT 0,
  `model` varchar(40) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`),
  KEY `idx_created` (`created_at`)
) ENGINE=InnoDB AUTO_INCREMENT=5242 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `ui_strings`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `ui_strings` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `key_name` varchar(120) NOT NULL,
  `locale` varchar(10) NOT NULL DEFAULT 'en',
  `value` text NOT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ui_string` (`key_name`,`locale`),
  KEY `idx_locale` (`locale`)
) ENGINE=InnoDB AUTO_INCREMENT=2578 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `user_achievements`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_achievements` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `passport_id` bigint(20) unsigned NOT NULL,
  `achievement_key` varchar(60) NOT NULL,
  `unlocked_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_passport_key` (`passport_id`,`achievement_key`)
) ENGINE=InnoDB AUTO_INCREMENT=36 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `user_momentum`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_momentum` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `passport_id` bigint(20) unsigned NOT NULL,
  `last_activity_at` datetime NOT NULL,
  `streak_days` smallint(6) NOT NULL DEFAULT 0,
  `multiplier` decimal(4,2) NOT NULL DEFAULT 1.00,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `passport_id` (`passport_id`)
) ENGINE=InnoDB AUTO_INCREMENT=15 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `user_node_knowledge`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_node_knowledge` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `passport_id` bigint(20) unsigned NOT NULL,
  `node_external_id` varchar(20) NOT NULL,
  `percentage` tinyint(3) unsigned NOT NULL DEFAULT 0,
  `source` enum('self_reported','tested','estimated') NOT NULL DEFAULT 'self_reported',
  `updated_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_unk` (`passport_id`,`node_external_id`),
  CONSTRAINT `fk_unk_passport` FOREIGN KEY (`passport_id`) REFERENCES `learner_passports` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=428 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `user_settings`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_settings` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint(20) unsigned NOT NULL,
  `key_name` varchar(100) NOT NULL,
  `value` varchar(500) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_user_settings` (`user_id`,`key_name`),
  CONSTRAINT `fk_usettings_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=785 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `user_streaks`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_streaks` (
  `passport_id` bigint(20) unsigned NOT NULL,
  `current_streak` int(10) unsigned NOT NULL DEFAULT 0,
  `longest_streak` int(10) unsigned NOT NULL DEFAULT 0,
  `streak_savers` tinyint(3) unsigned NOT NULL DEFAULT 0,
  `last_completion_date` date DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`passport_id`),
  CONSTRAINT `fk_streaks_passport` FOREIGN KEY (`passport_id`) REFERENCES `learner_passports` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `email` varchar(255) NOT NULL,
  `password_hash` varchar(255) DEFAULT NULL,
  `email_verified` tinyint(1) NOT NULL DEFAULT 0,
  `email_verify_token` varchar(64) DEFAULT NULL,
  `email_verify_expires` datetime DEFAULT NULL,
  `role` enum('learner','teacher','parent','admin','super_admin') NOT NULL DEFAULT 'learner',
  `passport_id` bigint(20) unsigned DEFAULT NULL,
  `subscription_status` enum('free','subscriber','cancelled') NOT NULL DEFAULT 'free',
  `subscription_period_end` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `last_login` datetime DEFAULT NULL,
  `link_code` char(8) DEFAULT NULL,
  `link_code_role` enum('parent','teacher') DEFAULT NULL,
  `link_code_generated_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_users_email` (`email`),
  KEY `fk_users_passport` (`passport_id`),
  CONSTRAINT `fk_users_passport` FOREIGN KEY (`passport_id`) REFERENCES `learner_passports` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=34 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*M!100616 SET NOTE_VERBOSITY=@OLD_NOTE_VERBOSITY */;

