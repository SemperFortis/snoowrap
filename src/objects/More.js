import {concat, flatten, forEach, pick, remove} from 'lodash';
import Promise from '../Promise.js';
import {addEmptyRepliesListing, buildRepliesTree, handleJsonErrors} from '../helpers.js';
import {MAX_API_INFO_AMOUNT, MAX_API_MORECHILDREN_AMOUNT} from '../constants.js';

const api_type = 'json';

/**
 * The `More` class is a helper representing reddit's exposed `more` type in comment threads, used to fetch additional comments
 * on a thread.
 * No instances of the `More` class are exposed externally by snoowrap; instead, comment lists are exposed as Listings.
 * Additional replies on an item can be fetched by calling `fetchMore` on a Listing, in the same manner as what would be done
 * with a Listing of posts. snoowrap should handle the differences internally, and expose a nearly-identical interface for the
 * two use-cases.
 *
 * Combining reddit's `Listing` and `more` objects has the advantage of having a more consistent exposed interface; for example,
 * if a consumer iterates over the comments on a Submission, all of the iterated items will actually be Comment objects, so the
 * consumer won't encounter an unexpected `more` object at the end. However, there are a few disadvantages, namely that (a) this
 * leads to an increase in internal complexity, and (b) there are a few cases where reddit's `more` objects have different amounts
 * of available information (e.g. all the child IDs of a `more` object are known on creation), which leads to different optimal
 * behavior.
 */

const More = class More {
  constructor (options, _r) {
    Object.assign(this, options);
    this._r = _r;
  }
  /**
   * Requests to /api/morechildren are capped at 20 comments at a time, but requests to /api/info are capped at 100, so
   * it's easier to send to the latter. The disadvantage is that comment replies are not automatically sent from requests
   * to /api/info.
   */
  async fetchMore (options, startIndex = 0, children = {}, nested) {
    if (options.amount <= 0 || startIndex >= this.children.length) {
      return [];
    }
    if (!options.skipReplies) {
      return this.fetchTree(options, startIndex, children, nested);
    }
    const ids = getNextIdSlice(this.children, startIndex, options.amount, MAX_API_INFO_AMOUNT).map(id => `t1_${id}`);
    // Requests are capped at 100 comments. Send lots of requests recursively to get the comments, then concatenate them.
    // (This speed-requesting is only possible with comment Listings since the entire list of ids is present initially.)
    const thisBatch = await this._r._getListing({uri: 'api/info', qs: {id: ids.join(',')}});
    Object.assign(children, thisBatch._children);
    const nextRequestOptions = {...options, amount: options.amount - ids.length};
    const remainingItems = await this.fetchMore(nextRequestOptions, startIndex + ids.length, children, true);
    const res = flatten([thisBatch, remainingItems]);
    if (!nested) {
      res._children = children;
    }
    return res;
  }
  async fetchTree (options, startIndex, children = {}, nested) {
    if (options.amount <= 0 || startIndex >= this.children.length) {
      return [];
    }
    const ids = getNextIdSlice(this.children, startIndex, options.amount, MAX_API_MORECHILDREN_AMOUNT);
    const res = await this._r._get({
      url: 'api/morechildren',
      params: {api_type, children: ids.join(','), link_id: this.link_id || this.parent_id}
    });
    handleJsonErrors(res);
    let resultTrees = buildRepliesTree(res.json.data.things.map(addEmptyRepliesListing));
    Object.assign(children, res._children);
    /**
     * Sometimes, when sending a request to reddit to get multiple comments from a `more` object, reddit decides to only
     * send some of the requested comments, and then stub out the remaining ones in a smaller `more` object. ( ¯\_(ツ)_/¯ )
     * In these cases, recursively fetch the smaller `more` objects as well.
     */
    const childMores = remove(resultTrees, c => c instanceof More);
    forEach(childMores, c => c.link_id = this.link_id || this.parent_id);
    const expandedTrees = await Promise.all(childMores.map(c => c.fetchTree({...options, amount: Infinity}, 0, children, true)));
    const nexts = await this.fetchMore({...options, amount: options.amount - ids.length}, startIndex + ids.length, children, true);
    resultTrees = concat(resultTrees, flatten(expandedTrees), nexts);
    if (!nested) {
      resultTrees._children = children;
    }
    return resultTrees;
  }
  _clone () {
    return new More(pick(this, Object.getOwnPropertyNames(this)), this._r);
  }
};

function getNextIdSlice (children, startIndex, desiredAmount, limit) {
  return children.slice(startIndex, startIndex + Math.min(desiredAmount, limit));
}

export const emptyChildren = new More({children: []});
export default More;
