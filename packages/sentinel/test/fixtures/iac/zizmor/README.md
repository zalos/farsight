Original synthetic CI configuration for the zizmor adapter tests (PR 13). Each file carries a `.fixture` name so no
tool treats this folder as a workflow; the tests copy them into a temporary captured tree under real names (see
`test/iac-helpers.ts`). Nothing here runs in CI. Action references are illustrative and are not executed.
