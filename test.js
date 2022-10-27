// const incidents = require('./testIncident.json')
const {
  filterIncidentsWithPedBikeUpdates,
  filterVehicleOnlyIncidents,
  filterPedBikeIncidents,
  handleFiltering
} = require("./index")
const representatives = require("./representatives");
const argv = require('minimist')(process.argv.slice(2))

// console.log(data.results.map(x => x.title))

const checkText = (x) => ({
  raw: x.raw,
  updates: x.updates && Object.values(x.updates).map(update => update.text)
})


if (representatives[argv.location].length) {
  const councilMembersAndTagsTweet = `${representatives[argv.location].join(' ')}`;
  console.log(councilMembersAndTagsTweet)
}


// console.log(filterIncidentsWithPedBikeUpdates(incidents).map(x => checkText(x)))

// console.log(filterPedBikeIncidents(data.results).map(x => checkText(x)))

// console.log(filterVehicleOnlyIncidents(incidents).map(x => checkText(x)))

// richmond
// https://citizen.com/api/incident/trending?lowerLatitude=37.425128&lowerLongitude=-77.669312&upperLatitude=37.716030&upperLongitude=-77.284938&fullResponse=true&limit=200

// philly
// https://citizen.com/api/incident/trending?lowerLatitude=39.837744&lowerLongitude=-75.315660&upperLatitude=40.136024&upperLongitude=-74.973228&fullResponse=true&limit=200


// const targetTimeInMs = Date.now() - (86400000 * 1)
// const currentIncidents = data.results.filter(x => x.ts > targetTimeInMs)
// console.log('currentIncidents', currentIncidents.length)
// const {summary, incidentList} = handleFiltering(currentIncidents);
// console.log('summary', summary)
// console.log('incidentList', incidentList.forEach(x => {
//   console.log(new Date(x.ts), x.raw)
//   if (x.updates) {
//     console.log('update text', Object.values(x.updates).map(update => update.text))
//   }
// }))