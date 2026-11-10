// Reading one test out of a .ht file's text: the comment above it and the lines it spans.

const isComment = (line: string) => line.startsWith('#')
const isBlank = (line: string) => line.trim() === ''

/** The first line (1-based) of the comment block written right above a test, or the test's own line. */
function commentStart(lines: string[], testLine: number) {
  let start = testLine
  for (let i = testLine - 2; i >= 0; i--) {
    if (isComment(lines[i])) start = i + 1
    else if (!isBlank(lines[i])) break
  }
  return start
}

/**
 * The comment written right above a test ("# The whole of Island Hop in one story…"), as paragraphs.
 * Only comments at the start of a line count, so a comment inside the test before it isn't taken.
 */
export function testDescription(source: string, testLine: number): string[] {
  const lines = source.split(/\r?\n/)
  const start = commentStart(lines, testLine)
  const paragraphs: string[] = []
  let current: string[] = []
  for (let i = start - 1; i < testLine - 1; i++) {
    const text = lines[i].replace(/^#+\s?/, '').trim()
    if (!isComment(lines[i]) || !text) {
      if (current.length) paragraphs.push(current.join(' '))
      current = []
    } else current.push(text)
  }
  if (current.length) paragraphs.push(current.join(' '))
  return paragraphs
}

/** The lines of one test, from its `Test:` line up to the next test (or its comment), without trailing blanks. */
export function testRange(source: string, testLine: number, nextTestLine?: number): [number, number] {
  const lines = source.split(/\r?\n/)
  let end = nextTestLine ? commentStart(lines, nextTestLine) - 1 : lines.length
  while (end > testLine && isBlank(lines[end - 1])) end--
  return [testLine, end]
}

