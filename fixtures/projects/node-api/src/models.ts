import mongoose from 'mongoose';

export const User = mongoose.model('User', new mongoose.Schema({ email: String, password: String, role: String }));
export const Account = mongoose.model('Account', new mongoose.Schema({ owner: String, balance: Number }));
