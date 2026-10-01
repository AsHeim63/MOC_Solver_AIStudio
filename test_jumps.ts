import { runWaterHammerSimulation } from './src/solver';

const pipes = [
  { id: '1', length: 1000, diameter: 0.5, waveSpeed: 1000, frictionFactor: 0.02, endElevation: 10 },
];

const pump = {
  initialHead: 100,
  initialFlow: 0.5,
  tripTime: 2,
  haltTime: 5,
  elevation: 10,
};

const reservoir = {
  head: 10,
};

const results = runWaterHammerSimulation(pipes, pump, reservoir);

for (let i = 0; i < results.fullHistory.length; i += 5) {
    const step = results.fullHistory[i];
    if (step.time > 5 && step.time < 10) {
        console.log(`t=${step.time.toFixed(3)}: H5=${step.heads[5].toFixed(2)}, H10=${step.heads[10].toFixed(2)}, H15=${step.heads[15].toFixed(2)}`);
    }
}
