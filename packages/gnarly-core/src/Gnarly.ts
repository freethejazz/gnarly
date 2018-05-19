import { EventEmitter } from 'events'

import Blockstream from './Blockstream'
import Ourbit, {
  IPatch,
  IPersistInterface,
  ITypeStore,
  SetupFn,
  TypeStorer,
} from './Ourbit'

import Block, { IJSONBlock } from './models/Block'
import NodeApi from './models/NodeApi'
import { IReducer, ReducerType } from './reducer'

import { globalState } from './globalstate'
import { parsePath } from './utils'

export type OnBlockHandler = (block: Block) => () => Promise<void>

class Gnarly extends EventEmitter {
  public ourbit: Ourbit
  public blockstreamer: Blockstream
  public shouldResume: boolean = true

  constructor (
    private stateReference: object,
    private storeInterface: IPersistInterface,
    private nodeEndpoint: string,
    private typeStore: ITypeStore,
    private reducers: IReducer[],
  ) {
    super()
    globalState.setApi(new NodeApi(nodeEndpoint))

    this.ourbit = new Ourbit(
      this.stateReference,
      this.storeInterface,
      this.persistPatchHandler,
    )

    this.blockstreamer = new Blockstream(
      this.ourbit,
      this.handleNewBlock,
    )
  }

  public shaka = async (fromBlockHash: string) => {
    let latestBlockHash

    if (!this.shouldResume) {
      // we reset, so let's start from scratch
      latestBlockHash = fromBlockHash || null
      console.log(`Explicitely starting from ${latestBlockHash || 'HEAD'}`)
    } else {
      // otherwise, let's get some info and replay state
      const latestTransaction = await this.storeInterface.getLatestTransaction()
      latestBlockHash = latestTransaction ? latestTransaction.id : null
      // ^ latest transaction id happens to also be the latest block hash
      // so update this line if that ever becomes not-true
      console.log(`Attempting to reload state from ${latestBlockHash || 'HEAD'}`)
      // let's re-hydrate local state by replaying transactions
      await this.ourbit.resumeFromTxId(latestBlockHash)
    }

    // and now catch up from latestBlockHash
    //   (which is either forced by env or the last tx id)
    await this.blockstreamer.start(latestBlockHash)
    return this.bailOut.bind(this)
  }

  public bailOut = async () => {
    await this.blockstreamer.stop()
  }

  public reset = async (shouldReset: boolean = true) => {
    this.shouldResume = !shouldReset
    this.storeInterface.setup(shouldReset)
    for (const key of Object.keys(this.typeStore)) {
      const setup = this.typeStore[key].__setup as SetupFn
      await setup(shouldReset)
    }
  }

  private handleNewBlock = (rawBlock: IJSONBlock, syncing: boolean) => async () => {
    const block = await this.normalizeBlock(rawBlock)

    for (const reducer of this.reducers) {
      switch (reducer.config.type) {
        case ReducerType.Idempotent:
          if (!syncing) {
            // only call Idempotent reducers if not syncing
            await reducer.reduce(this.stateReference[reducer.config.key], block)
          }
          break
        case ReducerType.TimeVarying:
        case ReducerType.Atomic:
          await reducer.reduce(this.stateReference[reducer.config.key], block)
          break
        default:
          throw new Error(`Unexpected ReducerType ${reducer.config.type}`)
      }
    }

    this.emit('block', block)
  }

  private normalizeBlock = async (block: IJSONBlock): Promise<Block> => {
    return new Block(block)
  }

  private persistPatchHandler = async (txId: string, patch: IPatch) => {
    const { scope } = parsePath(patch.op.path)
    const storer = this.typeStore[scope].store as TypeStorer
    await storer(txId, patch)
  }
}

export default Gnarly
