export interface PipeSection {
  id: string;
  length: number; // m
  diameter: number; // m
  waveSpeed: number; // m/s
  frictionFactor: number; // f
  endElevation: number; // m
}

export interface SimulationResults {
  timeSteps: number[];
  nodes: {
    x: number;
    elevation: number;
    maxHead: number;
    minHead: number;
    steadyHead: number;
    maxVaporVolume: number;
  }[];
  timeHistory: {
    time: number;
    head: number;
    flow: number;
    flowNext?: number;
    vaporVolume: number;
  }[];
  fullHistory: {
    time: number;
    heads: number[]; // Head at each node in nodesResult
    flows?: number[];
    vapors?: number[]; // V_g at each node [m^3]
  }[];
}

export interface PumpParams {
  initialHead: number; // m (Total Head)
  initialFlow: number; // m3/s
  tripTime: number; // s
  haltTime: number; // s
  elevation: number; // m
}

export interface ReservoirParams {
  head: number; // m (Water Level Elevation)
}
