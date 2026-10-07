// Turns a shared WhatsApp location pin into a place name: postcodes.io for the UK, OpenStreetMap elsewhere.
// Only the coordinates are sent, never anything else about the person.

export async function describeLocation(lat: number, lon: number): Promise<string> {
  try {
    const res = await fetch(`https://api.postcodes.io/postcodes?lon=${lon}&lat=${lat}&limit=1`, { signal: AbortSignal.timeout(6000) });
    const body = (await res.json()) as { result?: { postcode: string; admin_district?: string; region?: string }[] | null };
    const r = body.result?.[0];
    if (r) return `near ${r.postcode}, ${[r.admin_district, r.region].filter(Boolean).join(", ")}`;
  } catch {
    // fall through to OpenStreetMap
  }
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&lat=${lat}&lon=${lon}`, {
      headers: { "user-agent": "inkling/1.0 (personal WhatsApp assistant)" },
      signal: AbortSignal.timeout(6000),
    });
    const body = (await res.json()) as { display_name?: string };
    if (body.display_name) return `near ${body.display_name.split(", ").slice(0, 4).join(", ")}`;
  } catch {
    // give up gracefully
  }
  return "";
}
