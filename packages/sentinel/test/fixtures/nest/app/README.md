Original synthetic Nest application for the PR 16 framework pack tests (`test/frameworks-nest.test.ts`). Files carry a
`.fixture` suffix so no tool treats this folder as a project; the tests copy them into a temporary Git repository under
their real names, capture it and parse the captured bytes. Nothing here is installed or run.
