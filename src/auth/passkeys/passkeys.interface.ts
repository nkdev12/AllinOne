export interface PasskeyCredentialData {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  deviceName?: string;
}

export interface RegistrationOptionsResponse {
  challenge: string;
  rp: {
    name: string;
    id: string;
  };
  user: {
    id: string;
    name: string;
    displayName: string;
  };
  pubKeyCredParams: Array<{
    type: "public-key";
    alg: number;
  }>;
  timeout: number;
  attestation: "none" | "direct";
}

export interface LoginOptionsResponse {
  challenge: string;
  timeout: number;
  rpId: string;
  allowCredentials?: Array<{
    id: string;
    type: "public-key";
    transports?: string[];
  }>;
}

