name: Pull request

description: |
  Describe the behavior that changed, and make sure the claim is checked by a test.

body:
  - type: markdown
    attributes:
      value: |
        AgentSnap's own tests are its specification. A change to behavior should come with the
        assertion that now covers it.

  - type: textarea
    id: summary
    attributes:
      label: What changed?
    validations:
      required: true

  - type: textarea
    id: behavior
    attributes:
      label: What observable behavior changed?
      description: |
        New assertion? Changed failure message? Different exit code or default? Say which, and
        what a user would notice.
    validations:
      required: true

  - type: textarea
    id: verification
    attributes:
      label: How was this verified?
      description: 'For example: `npm run verify`, `npm run test:e2e`, `npm run check:install`.'
    validations:
      required: true

  - type: checkboxes
    id: checks
    attributes:
      label: Checks
      options:
        - label: `npm run verify` passes.
        - label: Tests were added or updated for the behavior described above.
        - label: Documentation was updated where behavior, configuration or exit codes changed.
        - label: Snapshots under `.agentsnap/snapshots/` were regenerated only when the change is intended.