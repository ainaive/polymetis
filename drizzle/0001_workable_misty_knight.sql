CREATE TABLE "workspaceMembers" (
	"id" text PRIMARY KEY NOT NULL,
	"workspaceId" text NOT NULL,
	"userId" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaceMembers_workspace_user_uq" UNIQUE("workspaceId","userId")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "templateI18n" (
	"templateVersionId" text NOT NULL,
	"locale" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"body" text,
	CONSTRAINT "templateI18n_version_locale_uq" UNIQUE("templateVersionId","locale")
);
--> statement-breakpoint
CREATE TABLE "templateVersions" (
	"id" text PRIMARY KEY NOT NULL,
	"templateId" text NOT NULL,
	"version" integer NOT NULL,
	"publishedAt" timestamp with time zone,
	"inputSchema" jsonb NOT NULL,
	"toolPolicy" jsonb NOT NULL,
	"directives" text NOT NULL,
	"deliverable" jsonb NOT NULL,
	"rubric" text NOT NULL,
	"model" text NOT NULL,
	"effort" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "templateVersions_template_version_uq" UNIQUE("templateId","version")
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" text PRIMARY KEY NOT NULL,
	"workspaceId" text,
	"slug" text NOT NULL,
	"category" text NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "templates_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "runArtifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"runId" text NOT NULL,
	"path" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"storageKey" text,
	"content" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runArtifacts_run_path_uq" UNIQUE("runId","path")
);
--> statement-breakpoint
CREATE TABLE "runEvents" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"runId" text NOT NULL,
	"seq" integer NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "runEvents_run_seq_uq" UNIQUE("runId","seq")
);
--> statement-breakpoint
CREATE TABLE "runQueue" (
	"runId" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lockedBy" text,
	"lockedAt" timestamp with time zone,
	"runAfter" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspaceId" text,
	"userId" text,
	"templateVersionId" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"isDemo" boolean DEFAULT false NOT NULL,
	"queuedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"startedAt" timestamp with time zone,
	"endedAt" timestamp with time zone,
	"inputTokens" integer DEFAULT 0 NOT NULL,
	"outputTokens" integer DEFAULT 0 NOT NULL,
	"costUsd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "workspaceMembers" ADD CONSTRAINT "workspaceMembers_workspaceId_workspaces_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaceMembers" ADD CONSTRAINT "workspaceMembers_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templateI18n" ADD CONSTRAINT "templateI18n_templateVersionId_templateVersions_id_fk" FOREIGN KEY ("templateVersionId") REFERENCES "public"."templateVersions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templateVersions" ADD CONSTRAINT "templateVersions_templateId_templates_id_fk" FOREIGN KEY ("templateId") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_workspaceId_workspaces_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runArtifacts" ADD CONSTRAINT "runArtifacts_runId_runs_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runEvents" ADD CONSTRAINT "runEvents_runId_runs_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runQueue" ADD CONSTRAINT "runQueue_runId_runs_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workspaceId_workspaces_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_templateVersionId_templateVersions_id_fk" FOREIGN KEY ("templateVersionId") REFERENCES "public"."templateVersions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspaceMembers_userId_idx" ON "workspaceMembers" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "workspaces_slug_idx" ON "workspaces" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "templateVersions_current_idx" ON "templateVersions" USING btree ("templateId","version" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "templates_visibility_idx" ON "templates" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "templates_workspaceId_idx" ON "templates" USING btree ("workspaceId");--> statement-breakpoint
CREATE INDEX "runEvents_run_seq_idx" ON "runEvents" USING btree ("runId","seq");--> statement-breakpoint
CREATE INDEX "runQueue_claim_idx" ON "runQueue" USING btree ("state","runAfter");--> statement-breakpoint
CREATE INDEX "runs_workspaceId_idx" ON "runs" USING btree ("workspaceId");--> statement-breakpoint
CREATE INDEX "runs_templateVersionId_idx" ON "runs" USING btree ("templateVersionId");--> statement-breakpoint
CREATE INDEX "runs_gallery_idx" ON "runs" USING btree ("visibility","isDemo","queuedAt" DESC NULLS LAST);