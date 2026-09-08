import { z } from "zod";

export const AGENT_CAPABILITIES = [
  "video_analysis",
  "library_clip_analysis",
  "shot_tagging",
  "clip_matching",
  "trim_window_selection",
  "master_segmentation",
  "storyboard_planning",
  "caption_generation",
  "edit_note_interpretation",
  "video_generation",
  "transcription_timing",
] as const;

export const AgentCapabilityZ = z.enum(AGENT_CAPABILITIES);
export type AgentCapability = z.infer<typeof AgentCapabilityZ>;

export const AgentSettingsZ = z.object(
  Object.fromEntries(
    AGENT_CAPABILITIES.map((capability) => [capability, z.string().min(1)])
  ) as Record<AgentCapability, z.ZodString>
);

export type AgentSettings = z.infer<typeof AgentSettingsZ>;

export interface AgentCapabilityDefinition {
  id: AgentCapability;
  label: string;
  description: string;
  group: "Analysis" | "Matching" | "Planning" | "Editing" | "Generation" | "Timing";
}

export interface AgentOption {
  id: string;
  label: string;
  provider: string;
  model: string | null;
  description: string;
  status: "available" | "planned";
  supports: AgentCapability[];
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  video_analysis: "gemini:gemini-3.6-flash",
  library_clip_analysis: "gemini:gemini-3.6-flash",
  shot_tagging: "gemini:gemini-3.6-flash",
  clip_matching: "gemini:gemini-3.6-flash",
  trim_window_selection: "gemini:gemini-3.6-flash",
  master_segmentation: "gemini:gemini-3.6-flash",
  storyboard_planning: "gemini:gemini-3.6-flash",
  caption_generation: "gemini:gemini-3.6-flash",
  edit_note_interpretation: "gemini:gemini-3.6-flash",
  video_generation: "gemini:gemini-omni-1.1-flash",
  transcription_timing: "whisperx",
};

export const AGENT_CAPABILITY_DEFINITIONS: AgentCapabilityDefinition[] = [
  {
    id: "video_analysis",
    label: "Video analysis",
    description: "Raw downloaded video to normalized shots, transcript, tags, and summary.",
    group: "Analysis",
  },
  {
    id: "library_clip_analysis",
    label: "Library clip analysis",
    description: "Brand clip catalog metadata, product presence, transcript, and suggested tags.",
    group: "Analysis",
  },
  {
    id: "shot_tagging",
    label: "Shot tagging",
    description: "Shot screenshots and text context to controlled-vocabulary tags.",
    group: "Analysis",
  },
  {
    id: "clip_matching",
    label: "Clip matching",
    description: "Analyzed shots and clip library to ranked replacement recommendations.",
    group: "Matching",
  },
  {
    id: "trim_window_selection",
    label: "Trim window selection",
    description: "Source clip and target shot to best start/end moment.",
    group: "Matching",
  },
  {
    id: "master_segmentation",
    label: "Master segmentation",
    description: "Transcript/video to hook, claim, proof, demo, CTA, and filler segments.",
    group: "Planning",
  },
  {
    id: "storyboard_planning",
    label: "Storyboard planning",
    description: "Master segments to hook -> main -> end storyboard options.",
    group: "Planning",
  },
  {
    id: "caption_generation",
    label: "Caption generation",
    description: "Analysis and concept to captions, hashtags, and posting copy.",
    group: "Planning",
  },
  {
    id: "edit_note_interpretation",
    label: "Edit-note interpretation",
    description: "Free-text editor notes to structured renderer directives.",
    group: "Editing",
  },
  {
    id: "video_generation",
    label: "Video generation",
    description: "Prompt/reference media to generated 9:16 video clips.",
    group: "Generation",
  },
  {
    id: "transcription_timing",
    label: "Transcription timing",
    description: "Speech timing and word alignment for master/storyboard workflows.",
    group: "Timing",
  },
];

const textAndVisionCapabilities: AgentCapability[] = [
  "video_analysis",
  "library_clip_analysis",
  "shot_tagging",
  "clip_matching",
  "trim_window_selection",
  "master_segmentation",
  "storyboard_planning",
  "caption_generation",
  "edit_note_interpretation",
];

export const AGENT_OPTIONS: AgentOption[] = [
  {
    id: "gemini:gemini-3.6-flash",
    label: "Gemini 3.6 Flash",
    provider: "Gemini",
    model: "gemini-3.6-flash",
    description: "Current default for structured text, vision, and video-understanding tasks.",
    status: "available",
    supports: [...textAndVisionCapabilities, "transcription_timing"],
  },
  {
    id: "gemini:gemini-omni-1.1-flash",
    label: "Gemini Omni 1.1 Flash",
    provider: "Gemini",
    model: "gemini-omni-1.1-flash",
    description: "Current default for per-shot video generation and extend flows.",
    status: "available",
    supports: ["video_generation"],
  },
  {
    id: "whisperx",
    label: "WhisperX",
    provider: "Local",
    model: "WHISPERX_MODEL",
    description: "Local word-level transcription and alignment for master/storyboard timing.",
    status: "available",
    supports: ["transcription_timing"],
  },
  {
    id: "openai:gpt-5",
    label: "OpenAI GPT-5",
    provider: "OpenAI",
    model: "gpt-5",
    description: "Placeholder for a future provider adapter and benchmark comparison.",
    status: "planned",
    supports: textAndVisionCapabilities,
  },
  {
    id: "anthropic:claude-sonnet",
    label: "Claude Sonnet",
    provider: "Anthropic",
    model: "claude-sonnet",
    description: "Placeholder for a future provider adapter and benchmark comparison.",
    status: "planned",
    supports: [
      "clip_matching",
      "master_segmentation",
      "storyboard_planning",
      "caption_generation",
      "edit_note_interpretation",
    ],
  },
];
