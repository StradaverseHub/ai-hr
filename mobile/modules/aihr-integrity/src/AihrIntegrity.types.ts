/** Native values stay unknown until the app validates them. None is a verified trust verdict. */
export type NativeIntegrityModule = {
  capabilities(): unknown;
  clockSnapshot(): unknown;
  appleKeyInfo(alias: string): Promise<unknown>;
  generateAppleKey(alias: string): Promise<unknown>;
  appleAttestationInfo(keyId: string, clientDataHash: string): Promise<unknown>;
  releaseAppleAttestation(keyId: string, clientDataHash: string): Promise<unknown>;
  resetAppleIntegrityInstallation(): Promise<unknown>;
  attestAppleKey(keyId: string, clientDataHash: string): Promise<unknown>;
  appleOfflineProofInfo?(keyId: string, clientDataHash: string): Promise<unknown>;
  assertAppleOfflineKey?(keyId: string, clientDataHash: string): Promise<unknown>;
  releaseAppleOfflineProof?(keyId: string, clientDataHash: string): Promise<unknown>;
  assertAppleKey(keyId: string, clientDataHash: string): Promise<unknown>;
  createAndroidKey(alias: string, challenge: string, strongBox: boolean): Promise<unknown>;
  androidKeyInfo(alias: string): Promise<unknown>;
  signAndroidCommand(alias: string, canonicalEnvelope: string): Promise<unknown>;
  preparePlayIntegrity(projectNumber: string): Promise<unknown>;
  requestPlayIntegrity(requestHash: string): Promise<unknown>;
};
