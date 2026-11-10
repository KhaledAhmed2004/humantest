/** A link that opens a file at a line in VS Code. `dir` is the folder the file path is relative to. */
export const editorLink = (dir: string, file: string, line: number) =>
  `vscode://file/${encodeURI(`${dir.replace(/\\/g, '/').replace(/\/$/, '')}/${file}`)}:${line}`

/** The same, for a file whose full path is known. */
export const fileLink = (path: string, line: number) => `vscode://file/${encodeURI(path.replace(/\\/g, '/'))}:${line}`
