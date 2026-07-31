CREATE TABLE `answers` (
	`id` text PRIMARY KEY NOT NULL,
	`assignment_id` text NOT NULL,
	`question_id` text NOT NULL,
	`student_id` text NOT NULL,
	`essay` text NOT NULL,
	`score_language` integer,
	`score_analysis` integer,
	`score_structure` integer,
	`score_understanding` integer,
	`annotations_language` text,
	`annotations_analysis` text,
	`structure_graph` text,
	`structure_description` text,
	`understanding_annotation` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "answers_score_language" CHECK("answers"."score_language" is null or ("answers"."score_language" between 0 and 5)),
	CONSTRAINT "answers_score_analysis" CHECK("answers"."score_analysis" is null or ("answers"."score_analysis" between 0 and 5)),
	CONSTRAINT "answers_score_structure" CHECK("answers"."score_structure" is null or ("answers"."score_structure" between 0 and 5)),
	CONSTRAINT "answers_score_understanding" CHECK("answers"."score_understanding" is null or ("answers"."score_understanding" between 0 and 5))
);
--> statement-breakpoint
CREATE INDEX `answers_assignment` ON `answers` (`assignment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `answers_question_student` ON `answers` (`question_id`,`student_id`);--> statement-breakpoint
CREATE TABLE `assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`paper_type` text DEFAULT 'p1' NOT NULL,
	`category` text NOT NULL,
	`project_name` text NOT NULL,
	`year_month` text,
	`boundaries` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "assignments_paper_type" CHECK("assignments"."paper_type" in ('p1', 'p2'))
);
--> statement-breakpoint
CREATE TABLE `examples` (
	`id` text PRIMARY KEY NOT NULL,
	`assignment_id` text NOT NULL,
	`essay` text NOT NULL,
	`commentary` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`assignment_id` text NOT NULL,
	`status` text NOT NULL,
	`total_answers` integer NOT NULL,
	`completed_answers` integer DEFAULT 0 NOT NULL,
	`failed_answers` integer DEFAULT 0 NOT NULL,
	`pid` integer,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "jobs_status" CHECK("jobs"."status" in ('queued', 'running', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `jobs_assignment` ON `jobs` (`assignment_id`);--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`assignment_id` text NOT NULL,
	`position` integer NOT NULL,
	`question` text NOT NULL,
	`context` text,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `questions_assignment_position` ON `questions` (`assignment_id`,`position`);--> statement-breakpoint
CREATE TABLE `score_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`answer_id` text NOT NULL,
	`criterion` text NOT NULL,
	`old_value` integer,
	`new_value` integer,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`answer_id`) REFERENCES `answers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "score_audit_criterion" CHECK("score_audit"."criterion" in ('language', 'analysis', 'structure', 'understanding')),
	CONSTRAINT "score_audit_old_value" CHECK("score_audit"."old_value" is null or ("score_audit"."old_value" between 0 and 5)),
	CONSTRAINT "score_audit_new_value" CHECK("score_audit"."new_value" is null or ("score_audit"."new_value" between 0 and 5))
);
--> statement-breakpoint
CREATE INDEX `score_audit_answer` ON `score_audit` (`answer_id`);--> statement-breakpoint
CREATE TABLE `step_results` (
	`job_id` text NOT NULL,
	`answer_id` text NOT NULL,
	`step_id` integer NOT NULL,
	`status` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`output` text,
	`error` text,
	`started_at` integer,
	`finished_at` integer,
	PRIMARY KEY(`job_id`, `answer_id`, `step_id`),
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`answer_id`) REFERENCES `answers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "step_results_status" CHECK("step_results"."status" in ('pending', 'running', 'succeeded', 'failed')),
	CONSTRAINT "step_results_step_id" CHECK("step_results"."step_id" between 1 and 16)
);
--> statement-breakpoint
CREATE INDEX `step_results_job_status` ON `step_results` (`job_id`,`status`);--> statement-breakpoint
CREATE TABLE `students` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`class` integer,
	`number` integer
);
