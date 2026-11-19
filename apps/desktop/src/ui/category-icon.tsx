import {
  Brain,
  FileText,
  Globe,
  Mail,
  Network,
  Plug,
  ShieldQuestion,
  Terminal,
} from "lucide-react";
import type { ReactNode } from "react";
import type { CategoryIcon } from "../data/approval-text.js";

const GLYPH: Record<CategoryIcon, typeof Terminal> = {
  terminal: Terminal,
  file: FileText,
  web: Globe,
  memory: Brain,
  mail: Mail,
  connector: Plug,
  network: Network,
  generic: ShieldQuestion,
};

/** The glyph of a tool category: the same one on a decision card, a decided approval and an action row. */
export function categoryGlyph(icon: CategoryIcon, size = 14): ReactNode {
  const Glyph = GLYPH[icon];
  return <Glyph size={size} />;
}
