// Representative notebook used across contract tests. Every field here is one
// the Worker sanitizers keep, so a valid save/export/import round trip must
// return it unchanged.
export const CHECKLIST_KEYS = [
  "start-with-what-you-have",
  "wipe-marketplace-pc",
  "make-boot-usb",
  "what-os-to-pick",
  "first-weekend",
  "find-the-leftover-box",
  "first-ssh",
  "first-useful-service",
  "first-file-share",
  "first-backup",
  "local-chat-on-the-pc",
];

export function fullLab() {
  return {
    title: "Basement lab",
    inventory: [
      {
        id: "inv-optiplex",
        name: "Optiplex 7050",
        note: "Marketplace find, $60",
        role: "server",
        cpu: 4,
        ramGb: 16,
        storageGb: 512,
        watts: 35,
        needsAttention: true,
        attentionNote: "Fan rattles",
      },
      { id: "inv-switch", name: "8-port switch", note: "", role: "network", watts: 5 },
      { id: "inv-nas", name: "Old NAS", note: "2x4TB", role: "my closet thing", storageGb: 8000 },
    ],
    services: [
      { id: "svc-pihole", name: "Pi-hole", hostId: "inv-optiplex", ramMb: 256, cpuPct: 5, notes: "DNS", url: "http://pi.hole/admin" },
      { id: "svc-jellyfin", name: "Jellyfin", hostId: "inv-optiplex", ramMb: 2048, cpuPct: 60 },
      { id: "svc-unassigned", name: "Wishlist service" },
    ],
    checklist: Object.fromEntries(CHECKLIST_KEYS.map((k, i) => [k, { done: i % 3 === 0 }])),
    closet: {
      units: 12,
      slots: [
        { start: 1, height: 1, name: "Patch panel" },
        { start: 3, height: 2, name: "Optiplex shelf", inventoryId: "inv-optiplex" },
      ],
      ports: [
        { port: "1", label: "Uplink" },
        { port: "2", label: "Optiplex" },
      ],
    },
    hosts: [
      { hostname: "optiplex", ip: "192.168.1.20", note: "static lease" },
      { hostname: "nas", ip: "192.168.1.30", note: "" },
    ],
    bom: [
      { slug: "first-backup", status: "bought", note: "USB disk" },
      { slug: "make-boot-usb", status: "consider", note: "" },
      { slug: "what-os-to-pick", status: "skip", note: "Have one" },
    ],
    upsVa: 600,
    powerNote: "UPS covers the switch and Optiplex only",
  };
}

/** The notebook fields as GET /api/lab returns them, without volatile id/updated_at. */
export function notebookOf(lab) {
  const { id, updated_at, ...rest } = lab;
  return rest;
}

/** What the server is expected to hold after saving `input` (checklist expands to defaults). */
export function expectedStored(input, defaultsChecklist) {
  const out = structuredClone(input);
  out.checklist = structuredClone(defaultsChecklist);
  for (const [k, v] of Object.entries(input.checklist || {})) {
    if (out.checklist[k]) out.checklist[k].done = !!v.done;
  }
  return out;
}
