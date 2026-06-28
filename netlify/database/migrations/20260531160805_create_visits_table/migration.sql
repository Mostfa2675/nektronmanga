CREATE TABLE "visits" (
	"id" serial PRIMARY KEY,
	"visitor_id" text NOT NULL,
	"path" text,
	"referrer" text,
	"language" text,
	"timezone" text,
	"screen" text,
	"user_agent" text,
	"country" text,
	"city" text,
	"created_at" timestamp DEFAULT now()
);
