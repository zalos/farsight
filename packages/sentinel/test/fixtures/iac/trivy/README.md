Original synthetic configuration files for the Trivy adapter tests (PR 13). Each file carries a `.fixture` name so no
tool treats this folder as a project; the tests copy them into a temporary captured tree under real names (see
`test/iac-helpers.ts`). Nothing here is built, deployed or applied. Image names use `example.invalid`.
