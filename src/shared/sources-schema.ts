import { z } from "zod";

export const YouTubeChannelSchema = z.object({
  channelId: z.string().regex(/^UC[A-Za-z0-9_-]{20,30}$/, "must be a UC… YouTube channelId"),
  handle: z.string().regex(/^@[A-Za-z0-9._-]+$/).optional(),
  name: z.string().min(1),
  checkIntervalMinutes: z.number().int().positive().default(30),
});

export const SubstackNewsletterSchema = z.object({
  subdomain: z.string().regex(/^[a-z0-9][a-z0-9-]*$/i),
  name: z.string().min(1),
  checkIntervalMinutes: z.number().int().positive().default(60),
});

export const TwitterPersonSchema = z.object({
  handle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
  userId: z.string().regex(/^\d+$/),
  name: z.string().min(1),
  checkIntervalMinutes: z.number().int().positive().default(15),
});

export const TwitterBookmarksSchema = z.object({
  userId: z.string().regex(/^\d+$/),
  handle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/).optional(),
  checkIntervalMinutes: z.number().int().positive().default(30),
});

export const BlogFeedSchema = z.object({
  url: z.string().url(),
  name: z.string().min(1),
  type: z.enum(["rss", "atom", "direct"]).default("rss"),
  checkIntervalMinutes: z.number().int().positive().default(120),
});

export const SourcesConfigSchema = z.object({
  youtube: z.object({
    channels: z.array(YouTubeChannelSchema).default([]),
  }).default({ channels: [] }),
  substack: z.object({
    newsletters: z.array(SubstackNewsletterSchema).default([]),
  }).default({ newsletters: [] }),
  twitter: z.object({
    people: z.array(TwitterPersonSchema).default([]),
    bookmarks: TwitterBookmarksSchema.optional(),
  }).default({ people: [] }),
  blogs: z.object({
    feeds: z.array(BlogFeedSchema).default([]),
  }).default({ feeds: [] }),
});

export type YouTubeChannel = z.infer<typeof YouTubeChannelSchema>;
export type SubstackNewsletter = z.infer<typeof SubstackNewsletterSchema>;
export type TwitterPerson = z.infer<typeof TwitterPersonSchema>;
export type TwitterBookmarks = z.infer<typeof TwitterBookmarksSchema>;
export type BlogFeed = z.infer<typeof BlogFeedSchema>;
export type SourcesConfig = z.infer<typeof SourcesConfigSchema>;

export type SourceType =
  | "youtube"
  | "substack"
  | "twitter-people"
  | "twitter-bookmarks"
  | "blog";
