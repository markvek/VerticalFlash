import { z } from "zod";

export const CoTagSchema = z.object({
  name: z.string(),
  id: z.string().optional(),
});

export const VideoMetadataSchema = z.object({
  id: z.string(),
  caption: z.string(),
  thumbnail: z.string(),
  playCount: z.number(),
  likeCount: z.number(),
  commentCount: z.number(),
  shareCount: z.number(),
  authorHandle: z.string(),
  authorName: z.string(),
  authorAvatar: z.string(),
  duration: z.number(),
  createdAt: z.number(),
  playAddr: z.string().optional(),
});

export const ExtendedVideoMetadataSchema = VideoMetadataSchema.extend({
  authorFollowerCount: z.number().optional(),
  musicId: z.string().optional(),
  musicTitle: z.string().optional(),
  coTags: z.array(CoTagSchema).optional(),
});

export type VideoMetadata = z.infer<typeof VideoMetadataSchema>;
export type ExtendedVideoMetadata = z.infer<typeof ExtendedVideoMetadataSchema>;
