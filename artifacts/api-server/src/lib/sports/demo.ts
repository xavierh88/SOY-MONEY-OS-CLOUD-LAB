export function generateDemoTriplets() {
  return [
    {
      id: "triplet-001",
      sport: "SOCCER",
      picks: [
        "Team Alpha WIN",
        "Team Beta OVER 2.5",
        "Team Gamma DOUBLE_CHANCE"
      ],
      status: "PENDING",
      createdAt: new Date().toISOString()
    }
  ];
}
