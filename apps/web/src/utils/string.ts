import { remark } from "remark";
import strip from "strip-markdown";

export async function stripMarkdown(content: string) {
  const file = await remark().use(strip).process(content);
  let stripped = String(file);
  if (!content.endsWith("\n")) {
    // file deepcode ignore ReplacementRegex: because it's remark who adds the \n, so we don't have to also check the \r\n
    stripped = stripped.replace(/\n$/, "");
  }
  return stripped;
}

/**
 * Finds the last index of a regex match in a string
 * @param string The string to search in
 * @param regex The regular expression to search for
 * @param startpos Optional starting position to search from (defaults to end of string)
 * @returns The index of the last match, or -1 if no match found
 */
export function regexLastIndexOf(
  string: string,
  regex: RegExp,
  startpos: number | undefined = undefined,
) {
  const cleanRegex = regex.global
    ? regex
    : new RegExp(
        regex.source,
        `g${regex.ignoreCase ? "i" : ""}${regex.multiline ? "m" : ""}`,
      );

  let cleanStartPos = startpos;
  if (cleanStartPos === undefined) {
    cleanStartPos = string.length;
  } else if (cleanStartPos < 0) {
    cleanStartPos = 0;
  }

  const stringToWorkWith = string.substring(0, cleanStartPos + 1);
  let lastIndexOf = -1;
  let nextStop = 0;
  let result;

  while ((result = cleanRegex.exec(stringToWorkWith)) !== null) {
    lastIndexOf = result.index;
    cleanRegex.lastIndex = ++nextStop;
  }
  return lastIndexOf;
}

/**
 * Slices a string without breaking words, optionally adding an ellipsis
 * @param str The string to slice
 * @param start The starting index to slice from
 * @param end The ending index to slice to
 * @param options Optional options object
 * @param options.ellipsis Optional ellipsis string to append (defaults to '...')
 * @param options.maxTrimmedLength Optional maximum cut length of the trimmed string (defaults to 10), put -1 to disable
 * @returns The sliced string, trimmed to the last complete word, with optional ellipsis
 */
export function sliceWithoutBreakWord(
  str: string,
  start: number,
  end: number,
  {
    ellipsis = "...",
    maxTrimmedLength = 10,
  }: { ellipsis?: string; maxTrimmedLength?: number } = {},
) {
  if (str.length <= end) {
    return str;
  }
  const trimmedString = str.substring(start, end);
  // re-trim if we are in the middle of a word
  const trimmedStringWithoutBreakWord = trimmedString.substring(
    0,
    Math.min(trimmedString.length, regexLastIndexOf(trimmedString, /\s/)),
  );

  if (
    maxTrimmedLength !== -1 &&
    trimmedStringWithoutBreakWord.length < end - start - maxTrimmedLength
  ) {
    // if the trimmed string is too short, return the original string)
    return `${trimmedString}${ellipsis}`;
  }
  return `${trimmedStringWithoutBreakWord}${ellipsis}`;
}

export async function excerptFromMarkdown(content: string, length = 100) {
  const stripped = await stripMarkdown(content);
  return sliceWithoutBreakWord(stripped, 0, length, { maxTrimmedLength: 10 });
}

export function slugify(text: string): string {
  return text
    .normalize("NFD") // Normalize accents
    .replace(/[\u0300-\u036f]/g, "") // Remove diacritics
    .toLowerCase() // Convert to lowercase
    .trim() // Remove leading/trailing spaces
    .replace(/[^a-z0-9\s-]/g, "") // Remove special chars except spaces and hyphens
    .replace(/[\s_]+/g, "-") // Replace spaces and underscores with hyphens
    .replace(/-+/g, "-"); // Remove consecutive hyphens
}
