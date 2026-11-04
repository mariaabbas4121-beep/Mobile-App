import type { GeoPoint } from '../api/types';

// Areas a user can pick when they do not share their location. The points
// are approximate centres (good to a few hundred metres), used only as the
// origin of a nearby search; they are never stored or sent anywhere else.

export interface Place extends GeoPoint {
  id: string;
  name: string;
  city: string;
}

export interface City extends GeoPoint {
  name: string;
  places: Place[];
}

const place = (city: string, id: string, name: string, latitude: number, longitude: number): Place => ({
  id,
  name,
  city,
  latitude,
  longitude,
});

export const CITIES: City[] = [
  {
    name: 'Faisalabad',
    latitude: 31.4187,
    longitude: 73.0791,
    places: [
      place('Faisalabad', 'fsd-uaf', 'UAF campus', 31.431, 73.07),
      place('Faisalabad', 'fsd-clock-tower', 'Clock Tower / Saddar', 31.4187, 73.0791),
      place('Faisalabad', 'fsd-peoples-colony', "People's Colony", 31.4007, 73.1013),
      place('Faisalabad', 'fsd-madina-town', 'Madina Town', 31.4148, 73.1223),
      place('Faisalabad', 'fsd-gulberg', 'Gulberg', 31.4426, 73.0982),
    ],
  },
  {
    name: 'Lahore',
    latitude: 31.5204,
    longitude: 74.3587,
    places: [
      place('Lahore', 'lhr-gulberg', 'Gulberg', 31.5161, 74.3487),
      place('Lahore', 'lhr-dha', 'DHA', 31.4697, 74.4058),
      place('Lahore', 'lhr-johar-town', 'Johar Town', 31.4697, 74.2728),
      place('Lahore', 'lhr-model-town', 'Model Town', 31.4834, 74.3237),
    ],
  },
  {
    name: 'Islamabad',
    latitude: 33.6844,
    longitude: 73.0479,
    places: [
      place('Islamabad', 'isb-f7', 'F-7', 33.7206, 73.0571),
      place('Islamabad', 'isb-g9', 'G-9', 33.6938, 73.0306),
      place('Islamabad', 'isb-i8', 'I-8', 33.6684, 73.0756),
    ],
  },
  {
    name: 'Rawalpindi',
    latitude: 33.5651,
    longitude: 73.0169,
    places: [
      place('Rawalpindi', 'rwp-saddar', 'Saddar', 33.5944, 73.0544),
      place('Rawalpindi', 'rwp-satellite-town', 'Satellite Town', 33.6372, 73.0703),
    ],
  },
  {
    name: 'Karachi',
    latitude: 24.8607,
    longitude: 67.0011,
    places: [
      place('Karachi', 'khi-clifton', 'Clifton', 24.8138, 67.0299),
      place('Karachi', 'khi-gulshan', 'Gulshan-e-Iqbal', 24.9204, 67.0932),
      place('Karachi', 'khi-pechs', 'PECHS', 24.8687, 67.0597),
    ],
  },
  {
    name: 'Multan',
    latitude: 30.1575,
    longitude: 71.5249,
    places: [place('Multan', 'mux-cantt', 'Cantt', 30.1872, 71.4595)],
  },
];

export const cityNamed = (name: string | null | undefined): City | undefined =>
  name ? CITIES.find((c) => c.name.toLowerCase() === name.trim().toLowerCase()) : undefined;
