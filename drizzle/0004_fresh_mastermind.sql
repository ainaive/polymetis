CREATE TABLE "githubInstallations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspaceId" text NOT NULL,
	"installationId" text NOT NULL,
	"accountLogin" text NOT NULL,
	"connectedByUserId" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "githubInstallations_installationId_uq" UNIQUE("installationId")
);
--> statement-breakpoint
ALTER TABLE "githubInstallations" ADD CONSTRAINT "githubInstallations_workspaceId_workspaces_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "githubInstallations" ADD CONSTRAINT "githubInstallations_connectedByUserId_users_id_fk" FOREIGN KEY ("connectedByUserId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "githubInstallations_workspaceId_idx" ON "githubInstallations" USING btree ("workspaceId");