/** Every financier the API module talks to directly, by code. New lenders register here and nowhere else. */
import { concertClient } from "./concert";
import { enfinClient } from "./enfin";
import { goodleapClient } from "./goodleap";
import { palmettoClient } from "./palmetto";
import { sunrunClient } from "./sunrun";
import type { FinancierApiProvider, ProviderClient } from "./types";

export const PROVIDER_CLIENTS: Record<FinancierApiProvider, ProviderClient> = {
  ENFIN: enfinClient, CONCERT: concertClient, GOODLEAP: goodleapClient, PALMETTO: palmettoClient, SUNRUN: sunrunClient,
};

export function providerClient(code: FinancierApiProvider): ProviderClient { return PROVIDER_CLIENTS[code]; }
