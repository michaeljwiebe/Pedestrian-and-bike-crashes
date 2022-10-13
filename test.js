const data = require('./testData.json')
const incidents = require('./testIncident.json')
const {
  filterIncidentsWithPedBikeUpdates,
  filterVehicleOnlyIncidents,
  filterPedBikeIncidents,
  handleFiltering
} = require("./index")

// console.log(data.results.map(x => x.title))

const checkText = (x) => ({
  raw: x.raw,
  updates: x.updates && Object.values(x.updates).map(update => update.text)
})

// console.log(filterIncidentsWithPedBikeUpdates(incidents).map(x => checkText(x)))

// console.log(filterPedBikeIncidents(data.results).map(x => checkText(x)))

// console.log(filterVehicleOnlyIncidents(incidents).map(x => checkText(x)))

// const targetTimeInMs = Date.now() - (86400000 * 1)
// const currentIncidents = data.results.filter(x => x.ts > targetTimeInMs)

// richmond
// https://citizen.com/api/incident/trending?lowerLatitude=37.425128&lowerLongitude=-77.669312&upperLatitude=37.716030&upperLongitude=-77.284938&fullResponse=true&limit=200

// philly
// https://citizen.com/api/incident/trending?lowerLatitude=39.837744&lowerLongitude=-75.315660&upperLatitude=40.136024&upperLongitude=-74.973228&fullResponse=true&limit=200

const {summary, incidentList} = handleFiltering(data.results);
console.log('summary', summary)
console.log('incidentList', incidentList.forEach(x => {
  console.log(new Date(x.ts), x.raw)
}))