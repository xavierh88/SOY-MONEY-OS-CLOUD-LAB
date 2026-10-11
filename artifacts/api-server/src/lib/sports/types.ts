export type SportEvent = {
  id: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
};

export type SportsTriplet = {
  createdAt: string;
  selections: {
    eventId: string;
    sport: string;
    homeTeam: string;
    awayTeam: string;
    commenceTime: string;
    pick: string;
    decimalOdds?: number;
    bookmaker?: string;
    capturedAt?: string;
  }[];
};
