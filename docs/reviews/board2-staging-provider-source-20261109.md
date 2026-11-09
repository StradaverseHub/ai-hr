# BOARD 2 staging provider source review

This merge combines the three BOARD 2 feedback changes in `23386e1e7f666ba1929cd885de429542008a2c60` with the verified staging source `b698f5d35b0cca12e2c1268f3bea08d0aa1d070e`. The provider source closure contains 1,488 files. Its fingerprint changes from `020279efedc544846db0bcc91e6fba27b8c49725169178fa8307c1bc8b6b394c` to `ffd2e1fec9fd42740bdd1cda8b4859237c78327bdca9471b17c9406b44eb58ce`.

The changed shared sources are the Employee Master projection, the Lifecycle Personnel reader and email model, the Onboarding and Lifecycle services, and six translation catalogues. Personnel export uses an optional employment filter in the existing projection. The Lifecycle flow resolves additional allowed merge fields for its existing email templates and excludes sensitive keys from previews and delivery. The provider transport, gateway, policy, contract inventory and disclosure roots are unchanged. These application flows use their existing authorization and delivery paths.

The requested renewal retains the 29 approved provider contracts and both pending contracts. It changes only their source fingerprint. The registry keeps its previous binding until the owner approves the exact reviewed source.

Company Configuration keeps the saved SSM and MyInvois values available to filing readers. The approved plan removes both input controls without adding a new entry point. The application still generates TP1 with a blank employer TIN when the company has no saved TIN. The SSM field is outside the application's blocking CP39 header checks. This staging release is for reviewing the requested screens and verifying filing behaviour with existing and new company records.
