import mammoth from "mammoth";
import type { Attachment } from "./chat.ts";

const MAX_BYTES = 25 * 1024 * 1024;

/** Turn an uploaded file into something the Messages API can take. */
export async function toAttachment(file: {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}): Promise<Attachment> {
  if (file.size > MAX_BYTES) {
    throw new Error(`«${file.originalname}» er for stor (maks 25 MB).`);
  }
  const name = file.originalname;
  const lower = name.toLowerCase();

  if (file.mimetype === "application/pdf" || lower.endsWith(".pdf")) {
    // PDFs go to the API natively as document blocks — no local parsing needed.
    return { kind: "pdf", name, base64: file.buffer.toString("base64") };
  }
  if (lower.endsWith(".docx")) {
    const { value } = await mammoth.extractRawText({ buffer: file.buffer });
    return { kind: "text", name, text: value.trim() };
  }
  if (lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".csv") || file.mimetype.startsWith("text/")) {
    return { kind: "text", name, text: file.buffer.toString("utf8") };
  }
  throw new Error(`Filtypen til «${name}» støttes ikke. Bruk PDF, DOCX, MD, TXT eller CSV.`);
}
