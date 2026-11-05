# Contributing to Tesseract

This file explains how to set up Tesseract, how to make a change, and how to send the change for
review.

## 1. Before you start

- For a small fix, start right away.
- For a new feature or a bigger change, talk to the maintainer first. A short message is enough:
  what you want to change and why. This saves work when the idea does not fit, or when somebody
  already works on it.

## 2. Set up

Install the tools from the [Requirements](README.md#requirements) section of the README. Then:

```
just install
just dev
```

`just dev` starts the app with live reload. `just` without a recipe lists all recipes.

## 3. Find your way in the code

| Folder | What it holds |
| --- | --- |
| `src/main` | The Electron main process: reviews, graph, Claude and the MCP server. |
| `src/preload` | The bridge that gives the window the `window.api` calls. |
| `src/renderer` | The React app in the window. |
| `src/shared` | Types and helpers that both sides use. |

Some starting points:

- **A new review server.** Implement the `ReviewSource` interface in `src/main/source.ts`. The
  Plastic version is in the same file, and the GitHub version is in `src/main/git.ts`.
- **A new language.** Add the tree-sitter grammar to `src/main/languages.ts`, and write a reader
  like `src/main/cpp.ts` or `src/main/rust.ts`. The reader returns the functions, the classes and
  the calls of a file. Exclude the source folders of the new grammar package in the `build.files`
  list of `package.json`.
- **The graph.** Units, call edges and clusters are made in `src/main/graph.ts`. The view is in
  `src/renderer/src/GraphView.tsx`.
- **Claude prompts.** They are in `src/main/claude.ts`.

## 4. Make the change

1. Make a branch from `main`. Give it a short name that says what it does, for example
   `fix-thread-filter` or `add-go-parser`.
2. Keep one topic per branch. A small change is reviewed faster and is safer to merge.
3. Write commit messages with a short title in the imperative ("Add Rust parsing", not "Added
   Rust parsing"). Use the body to say why, when the title does not say it.

## 5. Rules for the code

### Code

- TypeScript in strict mode. Follow the style of the code around you: two spaces, single quotes,
  no semicolons at the end of statements.
- Give a number with a special meaning a named constant, and say in its doc comment why it has
  that value.
- Prefer small, well-named helpers to long functions.

### Comments

- Keep comments short. Say the non-obvious "why" once, then stop.
- Write in simple technical English: one idea per sentence, about 20 words or fewer, active voice,
  and the same word for the same thing every time.
- Put a comment on its own line above the code, not at the end of a line of code.
- Do not write comments inside a function body. Put what the reader needs in the doc comment above
  the function. The only exception is a quirk that the code cannot show, for example a workaround
  for a bug in a library.

### Text in the app and in the docs

- Use plain, simple English with short sentences. Many users are not native English speakers.
- Use a hyphen (-) as the pause in a sentence, not the long dash. Use straight quotes (" and '),
  not curly quotes.

### Color-blind support

- No meaning may depend on color alone. Add a mark, a text label, a border style or a size change
  as well.
- Take new colors from the Okabe-Ito palette in `src/renderer/src/util.ts`.
- Put dark text on bright colors, and check the contrast.

## 6. Test the change

1. Run `just typecheck`. It must pass without errors.
2. Run `just build`.
3. Start the app and try the change on a real review. Check the parts that the change touches,
   for example both Plastic and GitHub, or both C++ and Rust.
4. Check that nothing else broke: open a review, select a few units, and read a thread.

**Do not post test content to real reviews.** Comments, replies, approvals and status changes go to
the server, and the whole team sees them. To test posting, use a review or a pull request that
you made for this purpose, and delete your test comments afterwards. A test of the Claude fix flow
changes files in your workspace. Never commit or push those changes.

## 7. Update the docs

- When the change adds or changes something that users see, update the [README](README.md).
- Keep the features in the README in the order of the review steps. The MCP server section stays
  the last feature.
- When the change makes a clip wrong, record it again and replace the WebP file in `docs/media`.
  Record on a public pull request, never on private code.

## 8. Send the change for review

1. Push your branch to your fork of the repository and open a pull request into `main`.
2. In the description, say:
   - what the change does and why,
   - how you tested it,
   - a screenshot or a short video for a change in the window.
3. The maintainer reviews the pull request. Answer each comment, with a code change or with a
   reply.
4. The maintainer merges the pull request when it is ready. Do not merge it yourself.

## 9. Releases

The maintainer makes the releases:

1. Raise the `version` in `package.json` with `just bump minor` (or `patch` or `major`), and merge
   that change into `main`.
2. The `Release` workflow sees the new version. It builds the installer, pushes the tag `v0.2.0`,
   and publishes the installer in a GitHub release.
3. When the tag of the version exists already, the workflow does nothing. To run it again after a
   failure, start it by hand on the Actions page of the repository.

The installed apps find the new release and update themselves. The `CI` workflow checks the types
and the build for each pull request and each push to `main`.
