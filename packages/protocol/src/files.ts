import { z } from "zod";
export const FileOperationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), directory: z.string().min(1), name: z.string().min(1).max(255), kind: z.enum(["file", "directory"]) }),
  z.object({ action: z.literal("rename"), path: z.string().min(1), name: z.string().min(1).max(255) }),
  z.object({ action: z.literal("copy"), paths: z.array(z.string().min(1)).min(1).max(100), directory: z.string().min(1) }),
  z.object({ action: z.literal("move"), paths: z.array(z.string().min(1)).min(1).max(100), directory: z.string().min(1) }),
  z.object({ action: z.literal("delete_prepare"), mode: z.enum(["trash", "permanent"]).optional(), paths: z.array(z.string().min(1)).min(1).max(100) }),
  z.object({ action: z.literal("delete"), token: z.string().min(1), confirm: z.literal(true) }),
]);
export interface FileMutationResult { ok: boolean; paths: string[]; failed?: { path: string; message: string }[]; token?: string }
export type FileOperation = z.infer<typeof FileOperationSchema>;
export interface FileEntry { name: string; path: string; kind: "file" | "directory" | "link" | "other"; size: number; modified: number; line?: number; excerpt?: string }
export interface FileListing { path: string; parent: string | null; entries: FileEntry[]; next: number | null; limited?: boolean }
export interface FilePreview { path: string; name: string; size: number; kind: "text" | "image" | "video" | "audio" | "other"; text?: string; truncated: boolean }
