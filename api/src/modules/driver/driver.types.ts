/** Linha de `drivers` como vem do banco. */
export interface MotoristaRow {
  id_driver: number;
  name: string;
  email: string;
  phone: string;
  cpf: string;
  city_id: number;
  category: string;
  status: string;
  rating: string | number;
  total_trips: number;
  vehicle_plate: string;
  vehicle_model: string;
  vehicle_brand: string;
  vehicle_color: string;
  vehicle_year: number;
  documents_ok: number;
  cnh_expires_at: string | null;
  bank_account: string | null;
  wallet_balance: string | number;
  last_connection: string | null;
  created_at: string;
}

/**
 * Registro que fica no cache de posição.
 *
 * Guardamos o cadastro junto para o app do passageiro
 * conseguir montar o card do motorista sem uma segunda
 * ida ao banco.
 */
export interface MotoristaPosicao {
  driverId: number;
  cityId: number;

  latitude: number;
  longitude: number;

  heading: number;
  speed: number;
  status: string;
  accuracy: number;

  socketClientId: string;

  lastConnection: string;
  updatedAt: string;

  cadastro: {
    name: string;
    email: string;
    phone: string;
    cpf: string;
    category: string;
    rating: number;
    totalTrips: number;
    documentsOk: boolean;
    cnhExpiresAt: string | null;
    bankAccount: string | null;
    walletBalance: number;
    createdAt: string;
  };

  veiculo: {
    plate: string;
    model: string;
    brand: string;
    color: string;
    year: number;
  };
}

/**
 * Projeção pública de `MotoristaPosicao` — o que pode sair da API (broadcast
 * de socket.io ou resposta HTTP) sem vazar dado sensível.
 *
 * `MotoristaPosicao.cadastro` carrega CPF, e-mail, telefone, conta bancária
 * e saldo de carteira; `socketClientId` é detalhe interno de sessão. Nenhum
 * consumidor real (a bancada só lê driverId/latitude/longitude/heading)
 * precisa de nada disso — só existe pra montar o card do motorista no app
 * do passageiro, que precisa apenas de nome, avaliação e veículo.
 */
export interface MotoristaPosicaoPublica {
  driverId: number;
  cityId: number;

  latitude: number;
  longitude: number;

  heading: number;
  speed: number;
  status: string;
  accuracy: number;

  nome: string;
  rating: number;

  veiculo: {
    plate: string;
    model: string;
    brand: string;
    color: string;
    year: number;
  };
}

export function paraExibicaoPublica(
  p: MotoristaPosicao,
): MotoristaPosicaoPublica {
  return {
    driverId: p.driverId,
    cityId: p.cityId,

    latitude: p.latitude,
    longitude: p.longitude,

    heading: p.heading,
    speed: p.speed,
    status: p.status,
    accuracy: p.accuracy,

    nome: p.cadastro.name,
    rating: p.cadastro.rating,

    veiculo: p.veiculo,
  };
}

export function montarPosicao(
  row: MotoristaRow,
  pos: {
    latitude: number;
    longitude: number;
    heading?: number;
    speed?: number;
    accuracy?: number;
  },
  socketClientId: string,
): MotoristaPosicao {
  const agora =
    new Date().toISOString();

  return {
    driverId: row.id_driver,
    cityId: row.city_id,

    latitude: pos.latitude,
    longitude: pos.longitude,

    heading: pos.heading ?? 0,
    speed: pos.speed ?? 0,

    status: row.status,

    accuracy: pos.accuracy ?? 12,

    socketClientId,

    lastConnection:
      row.last_connection ?? agora,

    updatedAt: agora,

    cadastro: {
      name: row.name,
      email: row.email,
      phone: row.phone,
      cpf: row.cpf,
      category: row.category,

      rating: Number(row.rating),

      totalTrips: row.total_trips,

      documentsOk:
        Boolean(row.documents_ok),

      cnhExpiresAt:
        row.cnh_expires_at,

      bankAccount:
        row.bank_account,

      walletBalance:
        Number(row.wallet_balance),

      createdAt:
        row.created_at,
    },

    veiculo: {
      plate: row.vehicle_plate,
      model: row.vehicle_model,
      brand: row.vehicle_brand,
      color: row.vehicle_color,
      year: row.vehicle_year,
    },
  };
}