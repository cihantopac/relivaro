import axios from 'axios';

export const http = axios.create({ baseURL: 'https://partners.example.com', timeout: 5000 });

export async function fetchPartner(id: string) {
  const res = await http.get(`/v1/partners/${encodeURIComponent(id)}`);
  return res.data;
}
