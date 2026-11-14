import { z } from "zod";
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const preferencesSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    theme: z.enum(["light", "dark", "paper"]),
    accent: color,
    categories: z
      .array(
        z
          .object({
            id: z.string().regex(/^[\w-]{1,40}$/),
            name: z.string().trim().min(2).max(50),
            color,
          })
          .strict(),
      )
      .max(30),
    storeDefault: z.boolean().default(false),
  })
  .strict()
  .refine(
    (input) =>
      new Set(input.categories.map((category) => category.id)).size ===
      input.categories.length,
    "Categorias duplicadas.",
  );
export type AgendaPreferences = z.infer<typeof preferencesSchema>;
export const defaults: AgendaPreferences = {
  revision: 0,
  theme: "light",
  accent: "#a54119",
  storeDefault: false,
  categories: [
    { id: "general", name: "Atendimento", color: "#397c96" },
    { id: "return", name: "Retorno", color: "#4d8658" },
    { id: "personal", name: "Pessoal", color: "#a57135" },
  ],
};
export const dossierSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    notes: z.string().max(4000).default(""),
    preferences: z.string().max(2000).default(""),
    tags: z.array(z.string().trim().min(1).max(40)).max(15).default([]),
    fields: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(50),
            value: z.string().max(500),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict();
export type Dossier = z.infer<typeof dossierSchema> & {
  updatedBy?: string;
  updatedAt?: string;
};
export interface RewardRule {
  goal: number;
  reward: string;
  redemptions: number;
  updatedAt: string;
}
