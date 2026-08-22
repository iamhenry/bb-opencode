import { PROVIDER_ID } from "../identity.js";

export function shouldRenderOpencodeChrome(
  providerId: string | null | undefined,
): boolean {
  return providerId === PROVIDER_ID;
}
