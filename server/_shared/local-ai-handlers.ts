// Private build entry for the personal Podman sidecar. It is compiled outside
// api/ and loaded only after the broker credential has been verified.
import { getCountryIntelBrief } from '../worldmonitor/intelligence/v1/get-country-intel-brief';
import { deductSituation } from '../worldmonitor/intelligence/v1/deduct-situation';
import { analyzeStock } from '../worldmonitor/market/v1/analyze-stock';

export async function runNativeReport(kind: string, input: Record<string, unknown>, request: Request): Promise<Response> {
  const ctx = { request, pathParams: {}, headers: Object.fromEntries(request.headers.entries()) };
  let result;
  if (kind === 'country') {
    result = await getCountryIntelBrief(ctx, { countryCode: String(input.countryCode), framework: '' });
  } else if (kind === 'situation') {
    result = await deductSituation(ctx, { query: String(input.query), geoContext: String(input.geoContext || ''), framework: '' });
  } else if (kind === 'stock') {
    result = await analyzeStock(ctx, { symbol: String(input.symbol), name: String(input.name || ''), includeNews: input.includeNews !== false });
  } else {
    return Response.json({ error: 'unsupported_report' }, { status: 400 });
  }
  return Response.json(result);
}
