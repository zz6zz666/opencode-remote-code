const BOM_CODE = 0xfeff
const BOM = String.fromCharCode(BOM_CODE)

export function splitBom(text: string): { bom: boolean; text: string } {
  if (text.charCodeAt(0) !== BOM_CODE) return { bom: false, text }
  return { bom: true, text: text.slice(1) }
}

export function joinBom(text: string, bom: boolean): string {
  const stripped = splitBom(text).text
  if (!bom) return stripped
  return BOM + stripped
}

export async function readFileWithBom(
  fs: typeof import("fs/promises"),
  filePath: string
): Promise<{ bom: boolean; text: string }> {
  const buf = await fs.readFile(filePath)
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf)
  return splitBom(text)
}
